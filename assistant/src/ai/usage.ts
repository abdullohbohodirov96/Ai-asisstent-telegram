import { and, gte, sql } from "drizzle-orm";
import { config } from "../config/env.js";
import { resolvePricing, estimateCostUsd } from "../config/pricing.js";
import { db, schema } from "../db/client.js";
import { startOfLocalDay, startOfLocalMonth, monthKey } from "../util/time.js";
import { log } from "../util/log.js";
import type { AIPurpose } from "./provider.js";

export async function recordUsage(u: {
  provider: string;
  model: string;
  purpose: AIPurpose;
  inputTokens: number;
  outputTokens: number;
  batchId?: number | null;
  success?: boolean;
}): Promise<number> {
  const cost = estimateCostUsd(u.model, u.inputTokens, u.outputTokens, resolvePricing(config().gemini.pricingJson));
  await db()
    .insert(schema.aiUsage)
    .values({
      provider: u.provider,
      model: u.model,
      purpose: u.purpose,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      estimatedCostUsd: cost,
      batchId: u.batchId ?? null,
      success: u.success ?? true,
    });
  return cost;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

async function summarySince(since: Date): Promise<UsageSummary & { byPurpose: Record<string, UsageSummary> }> {
  const rows = await db()
    .select({
      purpose: schema.aiUsage.purpose,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${schema.aiUsage.inputTokens}),0)::int`,
      outputTokens: sql<number>`coalesce(sum(${schema.aiUsage.outputTokens}),0)::int`,
      costUsd: sql<number>`coalesce(sum(${schema.aiUsage.estimatedCostUsd}),0)::float8`,
    })
    .from(schema.aiUsage)
    .where(gte(schema.aiUsage.createdAt, since))
    .groupBy(schema.aiUsage.purpose);
  const total: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const byPurpose: Record<string, UsageSummary> = {};
  for (const r of rows) {
    byPurpose[r.purpose] = { calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd };
    total.calls += r.calls;
    total.inputTokens += r.inputTokens;
    total.outputTokens += r.outputTokens;
    total.costUsd += r.costUsd;
  }
  return { ...total, byPurpose };
}

export const todayUsage = (now = new Date()) => summarySince(startOfLocalDay(now));
export const monthUsage = (now = new Date()) => summarySince(startOfLocalMonth(now));

export async function budgetRatio(now = new Date()): Promise<number> {
  const budget = config().budget.monthlyUsd;
  if (budget <= 0) return 0;
  const m = await monthUsage(now);
  return m.costUsd / budget;
}

/** Non-essential background work is paused once the monthly budget is used up (if BUDGET_HARD_STOP). */
export async function isBackgroundPaused(now = new Date()): Promise<boolean> {
  if (!config().budget.hardStop) return false;
  return (await budgetRatio(now)) >= 1;
}

export type Notifier = (text: string) => Promise<unknown>;

/** Sends 50% / 80% / 100% alerts once per month. Returns thresholds newly alerted. */
export async function checkBudgetAlerts(notify: Notifier, now = new Date()): Promise<number[]> {
  const ratio = await budgetRatio(now);
  const month = monthKey(now);
  const fired: number[] = [];
  for (const t of [50, 80, 100]) {
    if (ratio * 100 < t) continue;
    const ins = await db().insert(schema.budgetAlerts).values({ month, threshold: t }).onConflictDoNothing().returning();
    if (!ins.length) continue;
    fired.push(t);
    const budget = config().budget.monthlyUsd;
    const spent = (ratio * budget).toFixed(2);
    let text = `💸 AI byudjet: ${t}% ishlatildi ($${spent} / $${budget}, ${month}).`;
    if (t >= 100) {
      text += config().budget.hardStop
        ? "\nFon tahlili (batch analysis, profil o'rganish) pauzaga qo'yildi. Reportlar va sizning to'g'ridan-to'g'ri so'rovlaringiz ishlashda davom etadi. Xabarlar yo'qolmaydi — byudjet oshirilsa yoki yangi oy boshlansa tahlil davom etadi."
        : "\nBUDGET_HARD_STOP=false, shuning uchun tahlil davom etmoqda.";
    }
    try {
      await notify(text);
    } catch (e) {
      log.warn("budget alert send failed", { err: e });
    }
  }
  return fired;
}
