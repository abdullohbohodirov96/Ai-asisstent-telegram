import { config } from "../config/env.js";
import { processPendingUpdates, recoverStuckUpdates } from "../telegram/ingest.js";
import { formBatches } from "../engine/batcher.js";
import { analyzePendingBatches, recoverStuckBatches } from "../engine/analyzer.js";
import { askNextQuestion, expireStaleQuestions } from "../engine/questions.js";
import { sendDueReminders } from "../bot/owner.js";
import { runDueReports } from "../reports/service.js";
import { checkBudgetAlerts } from "../ai/usage.js";
import { notifyOwner } from "../bot/notify.js";
import { log } from "../util/log.js";

/**
 * One idempotent "tick" of all background work. Driven by:
 *   - the in-process interval (WORKER_INTERVAL_SECONDS), and
 *   - POST /internal/cron/analyze (external cron — survives host sleep/restart).
 * The DB is the queue, so a tick after a restart simply continues.
 */
let running: Promise<TickResult> | null = null;

export interface TickResult {
  updates: number;
  batchesFormed: number;
  batchesAnalysed: number;
  reports: Record<string, string>;
  errors: string[];
}

async function step<T>(name: string, errors: string[], fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errors.push(name);
    log.error(`worker step failed: ${name}`, { err: e });
    return fallback;
  }
}

export function tick(opts: { maxBatches?: number; now?: Date } = {}): Promise<TickResult> {
  if (running) return running;
  running = (async () => {
    const errors: string[] = [];
    const now = opts.now ?? new Date();
    await step("recover", errors, async () => {
      await recoverStuckUpdates();
      await recoverStuckBatches();
    }, undefined);
    const updates = await step("updates", errors, () => processPendingUpdates(), 0);
    const formed = await step("batch", errors, () => formBatches(now), [] as number[]);
    const analysed = await step("analyze", errors, () => analyzePendingBatches(opts.maxBatches ?? 5), 0);
    await step("questions", errors, async () => {
      await expireStaleQuestions(now);
      await askNextQuestion(now);
    }, undefined);
    await step("reminders", errors, () => sendDueReminders(now), 0);
    const reports = await step("reports", errors, () => runDueReports("scheduler", now), {} as Record<string, string>);
    await step("budget", errors, () => checkBudgetAlerts((t) => notifyOwner(t), now), [] as number[]);
    return { updates, batchesFormed: formed.length, batchesAnalysed: analysed, reports, errors };
  })().finally(() => {
    running = null;
  });
  return running;
}

let timer: NodeJS.Timeout | null = null;
export function startWorker() {
  if (config().disableWorker || timer) return;
  const ms = config().workerIntervalSeconds * 1000;
  timer = setInterval(() => void tick().catch((e) => log.error("tick failed", { err: e })), ms);
  timer.unref();
  // Startup recovery: pending updates, unanalysed batches, missed reports.
  void tick().catch((e) => log.error("startup tick failed", { err: e }));
}
export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Fire-and-forget nudge after a webhook stores an update. */
export function kick() {
  if (config().disableWorker) return;
  setImmediate(() => void processPendingUpdates().catch((e) => log.error("kick failed", { err: e })));
}
