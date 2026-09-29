import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "../src/db/client.js";
import { recordUsage, monthUsage, checkBudgetAlerts, isBackgroundPaused } from "../src/ai/usage.js";
import { generateStructured, BudgetPausedError } from "../src/ai/client.js";
import { estimateCostUsd, resolvePricing } from "../src/config/pricing.js";
import { enqueueUpdate, processPendingUpdates } from "../src/telegram/ingest.js";
import { formBatches } from "../src/engine/batcher.js";
import { analyzePendingBatches } from "../src/engine/analyzer.js";
import { z } from "zod";
import { resetDb, installFakeTelegram, installFakeAI, wire, businessMessage, emptyAnalysis, tash } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  installFakeAI(() => emptyAnalysis());
  wire();
});

describe("AI cost tracking", () => {
  it("records tokens and estimated cost per call from config-driven pricing (no hardcoded models)", async () => {
    await enqueueUpdate(businessMessage({ id: 1, text: "salom", date: tash("2026-09-29T10:00:00") }));
    await processPendingUpdates();
    await formBatches(tash("2026-09-29T10:10:00"));
    await analyzePendingBatches();
    const rows = await db().select().from(schema.aiUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("BATCH_ANALYSIS");
    expect(rows[0].model).toBe("test-fast");
    expect(rows[0].inputTokens).toBe(1000);
    expect(rows[0].outputTokens).toBe(200);
    expect(Number(rows[0].estimatedCostUsd)).toBeCloseTo((1000 * 1 + 200 * 2) / 1e6, 8);
    expect(rows[0].batchId).not.toBeNull();
    // unknown model → fallback price, never crashes
    expect(estimateCostUsd("some-new-model", 1_000_000, 0, resolvePricing(""))).toBeGreaterThan(0);
  });

  it("alerts at 50/80/100% once per month and pauses only non-essential background AI", async () => {
    await recordUsage({ provider: "fake", model: "test-deep", purpose: "REPORT", inputTokens: 1_000_000, outputTokens: 0 }); // $3 of $5 = 60%
    expect(await checkBudgetAlerts(async () => undefined)).toEqual([50]);
    expect(await checkBudgetAlerts(async () => undefined)).toEqual([]);
    await recordUsage({ provider: "fake", model: "test-deep", purpose: "REPORT", inputTokens: 700_000, outputTokens: 0 }); // $5.1
    const notes: string[] = [];
    expect(await checkBudgetAlerts(async (t) => notes.push(t))).toEqual([80, 100]);
    expect(notes[1]).toContain("pauzaga");
    expect(await isBackgroundPaused()).toBe(true);
    const schema0 = z.object({ ok: z.boolean() });
    await expect(generateStructured({ purpose: "BATCH_ANALYSIS", tier: "FAST", system: "", user: "", schema: schema0 })).rejects.toBeInstanceOf(BudgetPausedError);
    installFakeAI(() => ({ ok: true }));
    await expect(generateStructured({ purpose: "USER_QUERY", tier: "FAST", system: "", user: "", schema: schema0 })).resolves.toBeTruthy();
    expect((await monthUsage()).costUsd).toBeGreaterThan(5);
  });

  it("budget-paused batches stay PENDING (not lost) and are not counted as failures", async () => {
    await recordUsage({ provider: "fake", model: "test-deep", purpose: "REPORT", inputTokens: 2_000_000, outputTokens: 0 });
    await enqueueUpdate(businessMessage({ id: 1, text: "salom", date: tash("2026-09-29T10:00:00") }));
    await processPendingUpdates();
    await formBatches(tash("2026-09-29T10:10:00"));
    expect(await analyzePendingBatches()).toBe(0);
    const [b] = await db().select().from(schema.messageBatches);
    expect(b.status).toBe("PENDING");
    expect(b.attempts).toBe(0);
  });
});
