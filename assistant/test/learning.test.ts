import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { enqueueUpdate, processPendingUpdates } from "../src/telegram/ingest.js";
import { formBatches } from "../src/engine/batcher.js";
import { analyzePendingBatches } from "../src/engine/analyzer.js";
import { addEvidence, computePreferenceState, onMessagesDeleted } from "../src/engine/preferences.js";
import { resetDb, installFakeTelegram, installFakeAI, wire, businessMessage, emptyAnalysis, OWNER, tash } from "./helpers.js";
import type { BatchAnalysis } from "../src/ai/prompts/batch-analysis.js";

let next: BatchAnalysis = emptyAnalysis();
beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  installFakeAI(() => next);
  wire();
});

describe("Confidence system", () => {
  it("1 → HYPOTHESIS, 2–4 → LIKELY, 5+ → STABLE, contradictions lower it, owner word wins", () => {
    expect(computePreferenceState({ supporting: 1, contradicting: 0, confirmed: false, rejected: false }).status).toBe("HYPOTHESIS");
    expect(computePreferenceState({ supporting: 1, contradicting: 0, confirmed: false, rejected: false }).confidence).toBeLessThan(0.4);
    expect(computePreferenceState({ supporting: 3, contradicting: 0, confirmed: false, rejected: false }).status).toBe("LIKELY");
    expect(computePreferenceState({ supporting: 5, contradicting: 0, confirmed: false, rejected: false }).status).toBe("STABLE");
    const withContra = computePreferenceState({ supporting: 5, contradicting: 3, confirmed: false, rejected: false });
    expect(withContra.status).not.toBe("STABLE");
    expect(withContra.confidence).toBeLessThan(computePreferenceState({ supporting: 5, contradicting: 0, confirmed: false, rejected: false }).confidence);
    expect(computePreferenceState({ supporting: 1, contradicting: 0, confirmed: true, rejected: false })).toEqual({ confidence: 0.95, status: "STABLE" });
    expect(computePreferenceState({ supporting: 9, contradicting: 0, confirmed: false, rejected: true }).status).toBe("REJECTED");
  });

  it("contradicting evidence drops a LIKELY preference back", async () => {
    const create = { scope: "SCENARIO", projectId: null, statement: "Real odam bilan boshlanishini afzal ko'radi" };
    let id = 0;
    for (let i = 0; i < 3; i++) id = (await addEvidence({ create, polarity: "SUPPORTS", messageIds: [i + 1], source: "CHAT" }))!;
    let [p] = await db().select().from(schema.preferences);
    expect(p.status).toBe("LIKELY");
    expect(p.evidenceCount).toBe(3);
    const before = p.confidence;
    await addEvidence({ preferenceId: id, polarity: "CONTRADICTS", messageIds: [10], source: "CHAT" });
    await addEvidence({ preferenceId: id, polarity: "CONTRADICTS", messageIds: [11], source: "CHAT" });
    [p] = await db().select().from(schema.preferences);
    expect(p.confidence).toBeLessThan(before);
    expect(p.status).toBe("HYPOTHESIS");
    expect(await db().select().from(schema.preferences)).toHaveLength(1); // same statement not duplicated
  });

  it("deleted messages deactivate evidence and recompute confidence", async () => {
    const create = { scope: "DESIGN", projectId: null, statement: "Minimalizm" };
    await addEvidence({ create, polarity: "SUPPORTS", messageIds: [1], source: "CHAT" });
    await addEvidence({ create, polarity: "SUPPORTS", messageIds: [2], source: "CHAT" });
    let [p] = await db().select().from(schema.preferences);
    expect(p.status).toBe("LIKELY");
    await onMessagesDeleted([2]);
    [p] = await db().select().from(schema.preferences);
    expect(p.status).toBe("HYPOTHESIS");
    expect(p.evidenceCount).toBe(1);
  });
});

describe("Feedback learning", () => {
  it("rejection without reason → low-confidence hypothesis (project-scoped, not global) + FEEDBACK_REASON question", async () => {
    const [proj] = await db().insert(schema.projects).values({ name: "Al-Bayan" }).returning();
    next = emptyAnalysis({
      project: { existing_project_id: proj.id, name_mentioned: "Al-Bayan", confidence: 0.9, needs_clarification: false, is_new_project_candidate: false, evidence_message_ids: [1] },
      creative_submissions: [{ kind: "SCENARIO", description: "Al-Bayan reklama ssenariysi", submitted_by: "COUNTERPART", message_id: 1, confidence: 0.9 }],
      owner_feedback: [{ submission_index: 0, subject_kind: "SCENARIO", reaction: "REJECT", explicit_reason: null, inferred_reason: "generic deb hisoblagan bo'lishi mumkin", confidence: 0.8, evidence_message_ids: [2] }],
      preference_evidence: [{ scope: "SCENARIO", project_scoped: true, matches_preference_id: null, polarity: "NEW", statement: "Al-Bayan uchun generic ssenariylarni yoqtirmasligi mumkin", is_explicit: false, confidence: 0.3, evidence_message_ids: [2] }],
      clarification_questions: [{ kind: "FEEDBACK_REASON", question: "Al-Bayan ssenariysini rad qildingiz. Aynan nimasi yoqmadi?", importance: 0.8, related_task_index: null, related_feedback_index: 0, related_person_ref: null, evidence_message_ids: [2] }],
    });
    await enqueueUpdate(businessMessage({ id: 1, text: "Ssenariy tayyor: ...", date: tash("2026-09-29T12:00:00") }));
    await enqueueUpdate(businessMessage({ id: 2, from: OWNER, text: "Bunaqa bo'midi, juda oddiy.", date: tash("2026-09-29T12:01:00") }));
    await processPendingUpdates();
    await formBatches(tash("2026-09-29T12:30:00"));
    await analyzePendingBatches();

    const [fb] = await db().select().from(schema.feedbackEvents);
    expect(fb.reaction).toBe("REJECT");
    expect(fb.explicitReason).toBeNull();
    expect(fb.needsClarification).toBe(true);
    expect(fb.confidence).toBeLessThanOrEqual(0.4); // inferred reason is a guess
    const [sub] = await db().select().from(schema.creativeSubmissions);
    expect(sub.status).toBe("REJECTED");

    const prefs = await db().select().from(schema.preferences);
    expect(prefs).toHaveLength(1);
    expect(prefs[0].status).toBe("HYPOTHESIS"); // never STABLE from one event
    expect(prefs[0].scope).toBe("PROJECT");
    expect(prefs[0].projectId).toBe(proj.id); // not mixed into GLOBAL
    expect(prefs[0].confirmedByOwner).toBe(false);

    const qs = await db().select().from(schema.learningQuestions).where(eq(schema.learningQuestions.kind, "FEEDBACK_REASON"));
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toBe("Al-Bayan ssenariysini rad qildingiz. Aynan nimasi yoqmadi?");
    const evid = await db().select().from(schema.learningEvidence);
    expect(evid[0].messageIds.length).toBeGreaterThan(0);
  });

  it("project-scoped learning with unknown project is parked and attached once the project is known", async () => {
    next = emptyAnalysis({
      preference_evidence: [{ scope: "SCENARIO", project_scoped: true, matches_preference_id: null, polarity: "NEW", statement: "Dialog tabiiy bo'lishi kerak", is_explicit: true, confidence: 0.6, evidence_message_ids: [1] }],
      owner_feedback: [{ submission_index: null, subject_kind: "SCENARIO", reaction: "REVISION", explicit_reason: "dialog tabiiy emas", inferred_reason: null, confidence: 0.8, evidence_message_ids: [1] }],
    });
    await enqueueUpdate(businessMessage({ id: 1, from: OWNER, text: "Dialog tabiiy emas, qayta yozing", date: tash("2026-09-29T12:00:00") }));
    await processPendingUpdates();
    await formBatches(tash("2026-09-29T12:30:00"));
    await analyzePendingBatches();
    const [p] = await db().select().from(schema.preferences);
    expect(p.projectId).toBeNull();
    expect(p.scope).toBe("SCENARIO");
    expect(p.pendingProjectBatchId).not.toBeNull();
    const q = (await db().select().from(schema.learningQuestions)).find((x) => x.kind === "PROJECT");
    expect(q).toBeTruthy();
  });
});
