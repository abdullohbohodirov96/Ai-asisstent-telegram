import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { createQuestion, askNextQuestion, handleAnswer } from "../src/engine/questions.js";
import { enqueueUpdate, processPendingUpdates } from "../src/telegram/ingest.js";
import { resetDb, installFakeTelegram, installFakeAI, wire, ownerMessage, ownerTexts, type FakeAI } from "./helpers.js";

let ai: FakeAI;
beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  ai = installFakeAI(() => ({}));
  wire();
});

const evalOut = (over: Record<string, unknown>) => ({
  is_answer: true,
  sufficient: false,
  answer_summary: null,
  project_name: null,
  yes_no: null,
  role: null,
  learned: [],
  follow_up_question: null,
  acknowledgement: "Tushundim.",
  ...over,
});

async function feedbackQuestion() {
  const [proj] = await db().insert(schema.projects).values({ name: "Al-Bayan" }).returning();
  const [fb] = await db().insert(schema.feedbackEvents).values({ subjectKind: "SCENARIO", reaction: "REJECT", needsClarification: true, projectId: proj.id }).returning();
  const id = await createQuestion({ kind: "FEEDBACK_REASON", question: "Al-Bayan ssenariysini rad qildingiz. Aynan nimasi yoqmadi?", dedupeKey: "fb1", importance: 0.8, feedbackEventId: fb.id, projectId: proj.id });
  await askNextQuestion(new Date(), { ignoreHours: true });
  return { id: id!, proj, fb };
}

describe("Learning questions engine", () => {
  it("sufficient answer → RESOLVED, feedback reason stored, owner-confirmed project preference", async () => {
    const { id, proj, fb } = await feedbackQuestion();
    ai.handler = () =>
      evalOut({
        sufficient: true,
        answer_summary: "Juda reklamaviy; real odam bilan boshlanishi kerak",
        learned: [{ scope: "SCENARIO", project_scoped: true, statement: "Al-Bayan ssenariylari real odam bilan boshlanishi kerak, reklamaviy ohang yoqmaydi", confirms_preference_id: null, rejects_preference_id: null }],
        acknowledgement: "Tushundim, saqladim.",
      });
    await enqueueUpdate(ownerMessage({ id: 10, text: "Juda reklamaga o'xshab ketgan, real odam bilan boshlanishi kerak." }));
    await processPendingUpdates();
    const [q] = await db().select().from(schema.learningQuestions).where(eq(schema.learningQuestions.id, id));
    expect(q.status).toBe("RESOLVED");
    const [f] = await db().select().from(schema.feedbackEvents).where(eq(schema.feedbackEvents.id, fb.id));
    expect(f.explicitReason).toContain("reklamaviy");
    expect(f.needsClarification).toBe(false);
    const [p] = await db().select().from(schema.preferences);
    expect(p.confirmedByOwner).toBe(true);
    expect(p.status).toBe("STABLE");
    expect(p.projectId).toBe(proj.id);
    expect(ownerTexts().at(-1)).toBe("Tushundim, saqladim.");
  });

  it("vague answer → one focused follow-up; after 2 follow-ups → PARTIALLY_RESOLVED (no infinite loop)", async () => {
    const { id } = await feedbackQuestion();
    ai.handler = (req) => {
      const left = Number(/FOLLOW-UPS LEFT: (\d)/.exec(req.user)?.[1] ?? 0);
      return evalOut({ follow_up_question: left > 0 ? "Tushundim. Ko'proq qaysi tomoni: hook, syujet, juda reklamaviyligi yoki dialog?" : null });
    };
    for (let i = 0; i < 3; i++) {
      await enqueueUpdate(ownerMessage({ id: 20 + i, text: "prosto yoqmadi" }));
      await processPendingUpdates();
    }
    const [q] = await db().select().from(schema.learningQuestions).where(eq(schema.learningQuestions.id, id));
    expect(q.followUpCount).toBe(2);
    expect(q.status).toBe("PARTIALLY_RESOLVED");
    expect(ownerTexts().filter((t) => t.includes("hook, syujet")).length).toBe(2);
    expect((q.answers as unknown[]).length).toBe(3);
  });

  it("respects DAILY_MAX_LEARNING_QUESTIONS and asks one at a time by importance", async () => {
    for (let i = 0; i < 7; i++) await createQuestion({ kind: "OTHER", question: `Savol ${i}`, dedupeKey: `k${i}`, importance: i / 10 });
    const asked: number[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await askNextQuestion(new Date(), { ignoreHours: true });
      if (id) {
        asked.push(id);
        // while one is in flight nothing else is asked
        expect(await askNextQuestion(new Date(), { ignoreHours: true })).toBeNull();
        await db().update(schema.learningQuestions).set({ status: "RESOLVED" }).where(eq(schema.learningQuestions.id, id));
      }
    }
    expect(asked).toHaveLength(5);
    const first = (await db().select().from(schema.learningQuestions).where(eq(schema.learningQuestions.id, asked[0])))[0];
    expect(first.question).toBe("Savol 6"); // highest importance first
  });

  it("dedupes questions and ignores unrelated owner messages (falls through to assistant)", async () => {
    expect(await createQuestion({ kind: "OTHER", question: "A?", dedupeKey: "same", importance: 0.5 })).not.toBeNull();
    expect(await createQuestion({ kind: "OTHER", question: "A?", dedupeKey: "same", importance: 0.5 })).toBeNull();
    await askNextQuestion(new Date(), { ignoreHours: true });
    ai.handler = (req) => (req.purpose === "QUESTION_EVALUATION" ? evalOut({ is_answer: false }) : { reply_text: "Mana vazifalaringiz.", actions: [] });
    await enqueueUpdate(ownerMessage({ id: 30, text: "bugun nima ishlarim bor?" }));
    await processPendingUpdates();
    const [q] = await db().select().from(schema.learningQuestions);
    expect(q.status).toBe("ASKED");
    expect(ownerTexts().at(-1)).toContain("Mana vazifalaringiz");
  });

  it("voice answer: transcript shown first, then used as the answer", async () => {
    const { id } = await feedbackQuestion();
    ai.handler = () => evalOut({ sufficient: true, answer_summary: "reklamaviy", acknowledgement: "Saqladim." });
    await enqueueUpdate(ownerMessage({ id: 40, voice: true }));
    await processPendingUpdates();
    const texts = ownerTexts();
    const idx = texts.findIndex((t) => t.startsWith("🎙 Transkripsiya:"));
    expect(idx).toBeGreaterThan(-1);
    expect(texts[idx]).toContain("real odam bilan boshlanishi kerak");
    const [q] = await db().select().from(schema.learningQuestions).where(eq(schema.learningQuestions.id, id));
    expect(q.status).toBe("RESOLVED");
    const msgs = await db().select().from(schema.messages).where(eq(schema.messages.mediaType, "voice"));
    expect(msgs[0].transcript).toContain("real odam");
  });

  it("handleAnswer works directly for ROLE questions", async () => {
    const [p] = await db().insert(schema.persons).values({ name: "Sardor", telegramUserId: 7 }).returning();
    await createQuestion({ kind: "ROLE", question: "Sardor kim?", dedupeKey: "role:1", importance: 0.5, personId: p.id });
    const [q] = await db().select().from(schema.learningQuestions);
    ai.handler = () => evalOut({ sufficient: true, role: "videograf", answer_summary: "videograf" });
    await handleAnswer(q, "u videograf", null, { forceAnswer: true });
    const [pp] = await db().select().from(schema.persons).where(eq(schema.persons.id, p.id));
    expect(pp.role).toBe("videograf");
    expect(pp.roleConfirmed).toBe(true);
  });
});
