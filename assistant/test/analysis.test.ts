import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { enqueueUpdate, processPendingUpdates } from "../src/telegram/ingest.js";
import { formBatches } from "../src/engine/batcher.js";
import { analyzePendingBatches } from "../src/engine/analyzer.js";
import { askNextQuestion } from "../src/engine/questions.js";
import { resetDb, installFakeTelegram, installFakeAI, wire, businessMessage, callback, emptyAnalysis, ownerTexts, OWNER, tash, type FakeAI } from "./helpers.js";
import type { BatchAnalysis } from "../src/ai/prompts/batch-analysis.js";

let ai: FakeAI;
let next: BatchAnalysis = emptyAnalysis();

beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  ai = installFakeAI(() => next);
  wire();
});

async function ingestAndAnalyse(msgs: { id: number; from?: number; text: string; at: string }[]) {
  for (const m of msgs) await enqueueUpdate(businessMessage({ id: m.id, from: m.from, text: m.text, date: tash(m.at) }));
  await processPendingUpdates();
  await formBatches(tash("2026-09-29T23:00:00"));
  return analyzePendingBatches(10);
}

const task = (over: Partial<BatchAnalysis["tasks"][number]> = {}): BatchAnalysis["tasks"][number] => ({
  title: "Video tayyorlash",
  description: null,
  owner: "COUNTERPART",
  assigned_by: "OWNER",
  deadline_iso: "2026-09-30T18:00:00+05:00",
  remind_at_iso: null,
  priority: "HIGH",
  status: "TODO",
  existing_task_id: null,
  confidence: 0.9,
  evidence_message_ids: [1],
  ...over,
});

describe("AI extraction engine", () => {
  it("extracts a task: owner=Bobur, assigned by owner, deadline tomorrow (Tashkent)", async () => {
    next = emptyAnalysis({ tasks: [task()] });
    expect(await ingestAndAnalyse([{ id: 1, from: OWNER, text: "Bobur, ertaga video tayyor bo'lsin.", at: "2026-09-29T10:00:00" }])).toBe(1);
    const [t] = await db().select().from(schema.tasks);
    const [bobur] = await db().select().from(schema.persons).where(eq(schema.persons.telegramUserId, 2001));
    expect(t.ownerPersonId).toBe(bobur.id);
    expect(t.deadline?.toISOString()).toBe("2026-09-30T13:00:00.000Z");
    expect(t.evidenceMessageIds.length).toBeGreaterThan(0);
    expect(t.confidence).toBe(0.9);
    // prompt used the batch, not the whole history
    expect(ai.calls[0].user).toContain("THIS BATCH");
    expect(ai.calls[0].jsonSchema).toBeTruthy();
  });

  it("unknown project → project_id NULL, needs_clarification, and a precise question to the owner", async () => {
    next = emptyAnalysis({ tasks: [task()], project: { existing_project_id: null, name_mentioned: null, confidence: 0.2, needs_clarification: true, is_new_project_candidate: false, evidence_message_ids: [1] } });
    await ingestAndAnalyse([{ id: 1, from: OWNER, text: "Bobur, ertaga video tayyor bo'lsin.", at: "2026-09-29T10:00:00" }]);
    const [t] = await db().select().from(schema.tasks);
    expect(t.projectId).toBeNull();
    expect(t.needsClarification).toBe(true);
    const qs = await db().select().from(schema.learningQuestions);
    expect(qs).toHaveLength(1);
    expect(qs[0].kind).toBe("PROJECT");
    expect(qs[0].question).toMatch(/Boburga bergan "Video tayyorlash" vazifangiz qaysi loyiha uchun edi\?/);
    await db().insert(schema.projects).values({ name: "Al-Bayan" });
    // options were generated before the project existed → owner picks "Boshqa" and types; simulate via direct answer path instead:
    const qid = await askNextQuestion(new Date(), { ignoreHours: true });
    expect(qid).toBe(qs[0].id);
    expect(ownerTexts().at(-1)).toContain("qaysi loyiha");
  });

  it("links to a known project when AI is confident (project inference), without asking", async () => {
    const [p] = await db().insert(schema.projects).values({ name: "Al-Bayan", aliases: ["Albayan", "markaz"] }).returning();
    next = emptyAnalysis({ tasks: [task()], project: { existing_project_id: p.id, name_mentioned: "markaz", confidence: 0.9, needs_clarification: false, is_new_project_candidate: false, evidence_message_ids: [1] } });
    await ingestAndAnalyse([{ id: 1, from: OWNER, text: "Markaz uchun video ertaga", at: "2026-09-29T10:00:00" }]);
    const [t] = await db().select().from(schema.tasks);
    expect(t.projectId).toBe(p.id);
    expect(await db().select().from(schema.learningQuestions)).toHaveLength(0);
  });

  it("does NOT auto-link a project on low confidence alias match", async () => {
    await db().insert(schema.projects).values({ name: "Al-Bayan", aliases: ["markaz"] });
    next = emptyAnalysis({ tasks: [task()], project: { existing_project_id: 1, name_mentioned: "markaz", confidence: 0.5, needs_clarification: true, is_new_project_candidate: false, evidence_message_ids: [1] } });
    await ingestAndAnalyse([{ id: 1, from: OWNER, text: "markazga video", at: "2026-09-29T10:00:00" }]);
    const [t] = await db().select().from(schema.tasks);
    expect(t.projectId).toBeNull();
  });

  it("owner picks the project from inline buttons → task and batch get linked", async () => {
    await db().insert(schema.projects).values({ name: "Dunyabunya" });
    next = emptyAnalysis({ tasks: [task()] });
    await ingestAndAnalyse([{ id: 1, from: OWNER, text: "Bobur, ertaga video", at: "2026-09-29T10:00:00" }]);
    const qid = await askNextQuestion(new Date(), { ignoreHours: true });
    await enqueueUpdate(callback(`q:${qid}:0`));
    await processPendingUpdates();
    const [t] = await db().select().from(schema.tasks);
    const [p] = await db().select().from(schema.projects);
    expect(t.projectId).toBe(p.id);
    expect(t.needsClarification).toBe(false);
    const [q] = await db().select().from(schema.learningQuestions);
    expect(q.status).toBe("RESOLVED");
  });

  it("extracts commitments, waiting items, decisions and follow-ups with evidence", async () => {
    next = emptyAnalysis({
      commitments: [{ who: "COUNTERPART", to_whom: "OWNER", what: "Juma kuni dizayn yuboraman", due_iso: "2026-10-02T18:00:00+05:00", confidence: 0.85, evidence_message_ids: [1] }],
      waiting_items: [
        { direction: "OWNER_WAITS", person: "COUNTERPART", what: "Dizayn", due_iso: "2026-10-02T18:00:00+05:00", confidence: 0.8, evidence_message_ids: [1] },
        { direction: "WAITS_FOR_OWNER", person: "COUNTERPART", what: "Logo tasdig'i", due_iso: null, confidence: 0.7, evidence_message_ids: [2] },
      ],
      decisions: [{ what: "Ko'k rang tanlandi", why: "brendga mos", confidence: 0.8, evidence_message_ids: [2] }],
      followups: [{ title: "Qo'ng'iroq", kind: "CALL", when_iso: null, needs_clarification: true, confidence: 0.6, evidence_message_ids: [2] }],
    });
    await ingestAndAnalyse([
      { id: 1, text: "Juma kuni dizaynni yuboraman", at: "2026-09-29T11:00:00" },
      { id: 2, text: "Logoni tasdiqlaysizmi? Ko'k rang bo'lsinmi?", at: "2026-09-29T11:01:00" },
    ]);
    const [c] = await db().select().from(schema.commitments);
    expect(c.what).toContain("dizayn");
    expect(c.dueAt?.toISOString()).toBe("2026-10-02T13:00:00.000Z");
    expect(c.personId).not.toBeNull();
    const w = await db().select().from(schema.waitingItems);
    expect(w.map((x) => x.direction).sort()).toEqual(["OWNER_WAITS", "WAITS_FOR_OWNER"]);
    expect((await db().select().from(schema.decisions))[0].evidenceMessageIds.length).toBe(1);
    expect((await db().select().from(schema.meetingsFollowUps))[0].needsClarification).toBe(true);
  });

  it("filters hallucinated evidence ids and keeps only ids from the batch", async () => {
    next = emptyAnalysis({ decisions: [{ what: "x", why: null, confidence: 0.5, evidence_message_ids: [999, 1] }] });
    await ingestAndAnalyse([{ id: 1, text: "ok", at: "2026-09-29T11:00:00" }]);
    const [d] = await db().select().from(schema.decisions);
    const [m] = await db().select().from(schema.messages);
    expect(d.evidenceMessageIds).toEqual([m.id]);
  });

  it("retries with backoff when Gemini fails; messages are not lost", async () => {
    ai.handler = () => new Error("503 unavailable");
    await ingestAndAnalyse([{ id: 1, text: "salom", at: "2026-09-29T11:00:00" }]);
    let [b] = await db().select().from(schema.messageBatches);
    expect(b.status).toBe("FAILED");
    expect(b.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect((await db().select().from(schema.messages))[0].analysisStatus).toBe("FAILED");
    ai.handler = () => emptyAnalysis();
    await db().update(schema.messageBatches).set({ nextAttemptAt: new Date(0) });
    expect(await analyzePendingBatches()).toBe(1);
    [b] = await db().select().from(schema.messageBatches);
    expect(b.status).toBe("DONE");
    expect((await db().select().from(schema.messages))[0].analysisStatus).toBe("DONE");
  });
});
