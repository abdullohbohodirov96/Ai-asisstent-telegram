import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "../src/db/client.js";
import { runSlot, runDueReports } from "../src/reports/service.js";
import { gatherReportData } from "../src/reports/data.js";
import { resetDb, installFakeTelegram, installFakeAI, wire, ownerTexts, sent, OWNER, tash, type FakeAI } from "./helpers.js";

let ai: FakeAI;
beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  ai = installFakeAI((req) => (req.purpose === "REPORT" ? "🧠 QISQA HOLAT\n• Hammasi joyida\n\n➡️ KEYINGI ENG TO'G'RI 3 ACTION\n1. a\n2. b\n3. c" : new Error("no learning in test")));
  wire();
});

describe("Scheduled reports", () => {
  it("09:00 / 13:00 / 18:00 slots are idempotent (sequential and concurrent calls)", async () => {
    const now = tash("2026-09-29T09:01:00");
    expect(await runSlot("2026-09-29", "MORNING", "scheduler", now)).toBe("SENT");
    expect(await runSlot("2026-09-29", "MORNING", "cron", now)).toBe("ALREADY");
    const res = await Promise.all([runSlot("2026-09-29", "MIDDAY", "a", tash("2026-09-29T13:00:30")), runSlot("2026-09-29", "MIDDAY", "b", tash("2026-09-29T13:00:30"))]);
    expect(res.sort()).toEqual(["ALREADY", "SENT"]);
    expect(await runSlot("2026-09-29", "EVENING", "cron", tash("2026-09-29T17:59:00"))).toBe("NOT_DUE");
    expect(ownerTexts().filter((t) => t.includes("ERTALABKI"))).toHaveLength(1);
    expect(ownerTexts().filter((t) => t.includes("KUNDUZGI"))).toHaveLength(1);
    const runs = await db().select().from(schema.reportRuns);
    expect(runs.filter((r) => r.status === "SENT")).toHaveLength(2);
    expect(sent.every((s) => s.params.chat_id === OWNER)).toBe(true);
  });

  it("missed report recovery after restart/sleep: sends the latest due slot once, covers skipped windows", async () => {
    // host was asleep all morning; wakes up at 13:40
    const r1 = await runDueReports("startup", tash("2026-09-29T13:40:00"));
    expect(r1).toEqual({ MORNING: "SKIPPED", MIDDAY: "SENT" });
    const r2 = await runDueReports("scheduler", tash("2026-09-29T13:41:00"));
    expect(r2).toEqual({});
    expect(ownerTexts()).toHaveLength(1);
    // the midday report period starts at yesterday 18:00 (morning window folded in)
    expect(ownerTexts()[0]).toContain("28.09 18:00");
    // evening sent normally later
    expect(await runDueReports("scheduler", tash("2026-09-29T18:00:05"))).toEqual({ EVENING: "SENT" });
    expect(await runDueReports("scheduler", tash("2026-09-29T18:05:00"))).toEqual({});
  });

  it("uses a deterministic fallback when AI is unavailable (report still delivered)", async () => {
    ai.handler = () => new Error("gemini down");
    expect(await runSlot("2026-09-29", "EVENING", "cron", tash("2026-09-29T18:01:00"))).toBe("SENT");
    expect(ownerTexts()[0]).toContain("🧠 QISQA HOLAT");
    expect(ownerTexts()[0]).toContain("➡️ KEYINGI ENG TO'G'RI 3 ACTION");
    const [r] = await db().select().from(schema.reports);
    expect(r.usedAi).toBe(false);
  });

  it("report data contains owner actions, overdue delegated tasks and unresolved questions", async () => {
    const [owner] = await db().insert(schema.persons).values({ name: "Abdulloh", telegramUserId: OWNER, isOwner: true }).returning();
    const [bob] = await db().insert(schema.persons).values({ name: "Bobur", telegramUserId: 2001 }).returning();
    await db().insert(schema.tasks).values([
      { title: "Shartnomani imzolash", ownerPersonId: owner.id, deadline: tash("2026-09-30T15:00:00") },
      { title: "Video montaj", ownerPersonId: bob.id, deadline: tash("2026-09-28T18:00:00") },
    ]);
    await db().insert(schema.learningQuestions).values({ kind: "OTHER", question: "Savol?", dedupeKey: "x" });
    const d = await gatherReportData("EVENING", tash("2026-09-29T18:00:00"));
    expect(d.owner_tasks.map((t) => t.title)).toEqual(["Shartnomani imzolash"]);
    expect(d.delegated_tasks[0].overdue).toBe(true);
    expect(d.open_questions).toHaveLength(1);
    expect(d.stats.overdue).toBe(1);
  });
});
