import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { generateText } from "../ai/client.js";
import { REPORT_SYSTEM, buildReportPrompt } from "../ai/prompts/report.js";
import { notifyOwner } from "../bot/notify.js";
import { gatherReportData, windowFor, type ReportSlot } from "./data.js";
import { renderFallbackReport, reportTitle } from "./render.js";
import { localDate, nowLocal, slotTime, SLOTS, type Slot } from "../util/time.js";
import { refreshProfiles } from "../engine/learning.js";
import { log } from "../util/log.js";

export async function buildReportText(slot: ReportSlot, now = new Date(), sinceOverride?: Date): Promise<{ text: string; usedAi: boolean; model: string | null }> {
  const data = await gatherReportData(slot, now, sinceOverride);
  const title = reportTitle(slot, data.period);
  try {
    const { text, model } = await generateText({
      purpose: "REPORT",
      tier: "DEEP",
      system: REPORT_SYSTEM,
      user: buildReportPrompt(slot, nowLocal(now).toISO()!, JSON.stringify(data)),
    });
    if (!text.trim()) throw new Error("empty report");
    return { text: `${title}\n\n${text.trim()}`, usedAi: true, model };
  } catch (e) {
    log.warn("AI report failed, using fallback", { slot, err: e });
    return { text: `${title}\n\n${renderFallbackReport(data)}`, usedAi: false, model: null };
  }
}

export async function generateAndSendReport(slot: ReportSlot, now = new Date(), sinceOverride?: Date): Promise<number> {
  if (slot === "EVENING") {
    try {
      await refreshProfiles();
    } catch (e) {
      log.warn("profile refresh skipped", { err: e });
    }
  }
  const r = await buildReportText(slot, now, sinceOverride);
  const ids = await notifyOwner(r.text);
  const [row] = await db()
    .insert(schema.reports)
    .values({ slot, reportDate: localDate(now), text: r.text, model: r.model, usedAi: r.usedAi, telegramMessageIds: ids })
    .returning({ id: schema.reports.id });
  return row.id;
}

// ------------------------------------------------------------------ scheduled slots (idempotent)

const LOCK_TIMEOUT_MS = 10 * 60_000;

export type RunResult = "SENT" | "ALREADY" | "NOT_DUE" | "FAILED" | "SKIPPED";

/** Runs one slot for a date exactly once. Safe to call from the in-process scheduler AND external cron concurrently. */
export async function runSlot(date: string, slot: Slot, trigger: string, now = new Date(), opts: { force?: boolean; sinceOverride?: Date } = {}): Promise<RunResult> {
  if (!opts.force && slotTime(date, slot).toJSDate() > now) return "NOT_DUE";
  const d = db();
  await d.insert(schema.reportRuns).values({ reportDate: date, slot }).onConflictDoNothing();
  const claimed = await d
    .update(schema.reportRuns)
    .set({ status: "SENDING", lockedAt: now, attempts: sql`${schema.reportRuns.attempts} + 1`, trigger })
    .where(
      and(
        eq(schema.reportRuns.reportDate, date),
        eq(schema.reportRuns.slot, slot),
        or(eq(schema.reportRuns.status, "PENDING"), and(eq(schema.reportRuns.status, "FAILED"), lt(schema.reportRuns.attempts, 5)), and(eq(schema.reportRuns.status, "SENDING"), lt(schema.reportRuns.lockedAt, new Date(now.getTime() - LOCK_TIMEOUT_MS)))),
      ),
    )
    .returning();
  if (!claimed.length) return "ALREADY";
  try {
    const reportId = await generateAndSendReport(slot, now, opts.sinceOverride);
    await d.update(schema.reportRuns).set({ status: "SENT", sentAt: new Date(), reportId, error: null }).where(eq(schema.reportRuns.id, claimed[0].id));
    return "SENT";
  } catch (e) {
    log.error("report run failed", { slot, date, err: e });
    await d.update(schema.reportRuns).set({ status: "FAILED", error: String((e as Error)?.message ?? e).slice(0, 300) }).where(eq(schema.reportRuns.id, claimed[0].id));
    return "FAILED";
  }
}

/**
 * Missed-report protection: called on startup and every worker tick.
 * Sends today's due-but-unsent slots. If several are overdue (host slept),
 * earlier ones are marked SKIPPED and the latest report covers their window too,
 * so nothing is lost and the owner is not spammed with stale briefs.
 */
export async function runDueReports(trigger = "scheduler", now = new Date()): Promise<Record<string, RunResult>> {
  const date = localDate(now);
  const d = db();
  const due = SLOTS.filter((s) => slotTime(date, s).toJSDate() <= now);
  if (!due.length) return {};
  const runs = await d.select().from(schema.reportRuns).where(eq(schema.reportRuns.reportDate, date));
  const finished = new Set(runs.filter((r) => r.status === "SENT" || r.status === "SKIPPED").map((r) => r.slot));
  const pending = due.filter((s) => !finished.has(s));
  const result: Record<string, RunResult> = {};
  if (!pending.length) return result;

  const latest = pending[pending.length - 1];
  const superseded = pending.slice(0, -1);
  let sinceOverride: Date | undefined;
  for (const s of superseded) {
    await d.insert(schema.reportRuns).values({ reportDate: date, slot: s }).onConflictDoNothing();
    const upd = await d
      .update(schema.reportRuns)
      .set({ status: "SKIPPED", error: `superseded by ${latest}`, trigger })
      .where(and(eq(schema.reportRuns.reportDate, date), eq(schema.reportRuns.slot, s), inArray(schema.reportRuns.status, ["PENDING", "FAILED"])))
      .returning();
    if (upd.length) {
      const w = windowFor(s, now).since;
      if (!sinceOverride || w < sinceOverride) sinceOverride = w;
      result[s] = "SKIPPED";
    }
  }
  result[latest] = await runSlot(date, latest, trigger, now, { sinceOverride });
  return result;
}
