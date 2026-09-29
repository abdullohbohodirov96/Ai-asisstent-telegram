import { and, eq, gte, inArray, isNull, sql, desc, asc } from "drizzle-orm";
import { config } from "../config/env.js";
import { db, schema, type DB } from "../db/client.js";
import { generateStructured } from "../ai/client.js";
import { QUESTION_EVALUATOR_SYSTEM, QuestionEvaluationSchema, buildQuestionEvaluationPrompt, type QuestionEvaluation } from "../ai/prompts/question-evaluator.js";
import { notifyOwner } from "../bot/notify.js";
import { addEvidence, setOwnerVerdict } from "./preferences.js";
import { nowLocal, startOfLocalDay } from "../util/time.js";
import { log } from "../util/log.js";

/**
 * LEARNING QUESTIONS ENGINE
 * - at most DAILY_MAX_LEARNING_QUESTIONS new questions per Tashkent day
 * - one question in flight at a time
 * - highest importance first
 * - max 2 focused follow-ups per question, then PARTIALLY_RESOLVED
 */

export type QuestionKind = "PROJECT" | "NEW_PROJECT" | "ROLE" | "FEEDBACK_REASON" | "PREFERENCE" | "OTHER";
export interface QOption {
  label: string;
  value: string;
}

export interface NewQuestion {
  kind: QuestionKind;
  question: string;
  dedupeKey: string;
  importance: number;
  context?: Record<string, unknown>;
  options?: QOption[];
  projectId?: number | null;
  personId?: number | null;
  taskId?: number | null;
  feedbackEventId?: number | null;
  preferenceId?: number | null;
  batchId?: number | null;
}

export async function createQuestion(q: NewQuestion, x: DB = db()): Promise<number | null> {
  const rows = await x
    .insert(schema.learningQuestions)
    .values({
      kind: q.kind,
      question: q.question,
      dedupeKey: q.dedupeKey,
      importance: Math.max(0, Math.min(1, q.importance)),
      context: q.context ?? {},
      options: q.options ?? [],
      projectId: q.projectId ?? null,
      personId: q.personId ?? null,
      taskId: q.taskId ?? null,
      feedbackEventId: q.feedbackEventId ?? null,
      preferenceId: q.preferenceId ?? null,
      batchId: q.batchId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.learningQuestions.id });
  return rows[0]?.id ?? null;
}

const AWAIT_WINDOW_MS = 24 * 60 * 60_000;

export async function askedTodayCount(now = new Date()): Promise<number> {
  const [r] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.learningQuestions)
    .where(gte(schema.learningQuestions.askedAt, startOfLocalDay(now)));
  return r.n;
}

export async function awaitingQuestion(now = new Date()) {
  const [q] = await db()
    .select()
    .from(schema.learningQuestions)
    .where(and(eq(schema.learningQuestions.status, "ASKED"), gte(schema.learningQuestions.lastPromptAt, new Date(now.getTime() - AWAIT_WINDOW_MS))))
    .orderBy(desc(schema.learningQuestions.lastPromptAt))
    .limit(1);
  return q ?? null;
}

/** Questions unanswered for 24h go back to the pool with lower importance (or get dismissed). */
export async function expireStaleQuestions(now = new Date()): Promise<void> {
  const stale = await db()
    .select()
    .from(schema.learningQuestions)
    .where(and(eq(schema.learningQuestions.status, "ASKED"), sql`${schema.learningQuestions.lastPromptAt} < ${new Date(now.getTime() - AWAIT_WINDOW_MS)}`));
  for (const q of stale) {
    const importance = q.importance * 0.7;
    await db()
      .update(schema.learningQuestions)
      .set({ status: importance < 0.2 ? "DISMISSED" : "OPEN", importance })
      .where(eq(schema.learningQuestions.id, q.id));
  }
}

function withinQuestionHours(now: Date): boolean {
  const h = nowLocal(now).hour;
  const { hoursStart, hoursEnd } = config().questions;
  return h >= hoursStart && h < hoursEnd;
}

function keyboard(questionId: number, options: QOption[]) {
  if (!options.length) return undefined;
  return {
    inline_keyboard: options.slice(0, 8).map((o, i) => [{ text: o.label.slice(0, 60), callback_data: `q:${questionId}:${i}` }]),
  };
}

/** Sends the next most important question if limits allow. Returns the question id sent, or null. */
export async function askNextQuestion(now = new Date(), opts: { ignoreHours?: boolean } = {}): Promise<number | null> {
  const { dailyMax } = config().questions;
  if (dailyMax <= 0) return null;
  if (!opts.ignoreHours && !withinQuestionHours(now)) return null;
  if (await awaitingQuestion(now)) return null;
  if ((await askedTodayCount(now)) >= dailyMax) return null;

  const [q] = await db()
    .select()
    .from(schema.learningQuestions)
    .where(eq(schema.learningQuestions.status, "OPEN"))
    .orderBy(desc(schema.learningQuestions.importance), asc(schema.learningQuestions.createdAt))
    .limit(1);
  if (!q) return null;

  // Skip questions made obsolete (e.g. project was already set by another answer).
  if (q.kind === "PROJECT" && q.taskId) {
    const [t] = await db().select().from(schema.tasks).where(eq(schema.tasks.id, q.taskId));
    if (t?.projectId) {
      await db().update(schema.learningQuestions).set({ status: "DISMISSED", resolution: "loyiha allaqachon aniqlangan" }).where(eq(schema.learningQuestions.id, q.id));
      return askNextQuestion(now, opts);
    }
  }

  const claimed = await db()
    .update(schema.learningQuestions)
    .set({ status: "ASKED", askedAt: now, lastPromptAt: now })
    .where(and(eq(schema.learningQuestions.id, q.id), eq(schema.learningQuestions.status, "OPEN")))
    .returning();
  if (!claimed.length) return null;

  const options = (q.options as QOption[]) ?? [];
  const ids = await notifyOwner(`❓ ${q.question}`, { replyMarkup: keyboard(q.id, options) });
  await db()
    .update(schema.learningQuestions)
    .set({ telegramMessageId: ids[ids.length - 1] ?? null })
    .where(eq(schema.learningQuestions.id, q.id));
  return q.id;
}

/** Find which question an owner message answers: explicit reply first, else the one in flight. */
export async function findQuestionForReply(replyToTelegramMessageId: number | null, now = new Date()) {
  if (replyToTelegramMessageId) {
    const [q] = await db()
      .select()
      .from(schema.learningQuestions)
      .where(
        and(
          eq(schema.learningQuestions.telegramMessageId, replyToTelegramMessageId),
          inArray(schema.learningQuestions.status, ["ASKED", "OPEN", "PARTIALLY_RESOLVED"]),
        ),
      );
    if (q) return q;
  }
  return awaitingQuestion(now);
}

type QuestionRow = typeof schema.learningQuestions.$inferSelect;

export interface AnswerOutcome {
  handled: boolean;
  status?: "RESOLVED" | "PARTIALLY_RESOLVED" | "FOLLOW_UP";
}

/** Evaluate an owner answer; resolve, follow up, or mark partially resolved. */
export async function handleAnswer(q: QuestionRow, answer: string, messageRowId: number | null, opts: { forceAnswer?: boolean } = {}): Promise<AnswerOutcome> {
  const maxFollowUps = config().questions.maxFollowUps;
  const followUpsLeft = Math.max(0, maxFollowUps - q.followUpCount);
  const projects = await db().select({ name: schema.projects.name }).from(schema.projects);
  const hypotheses = q.preferenceId
    ? await db().select({ id: schema.preferences.id, statement: schema.preferences.statement }).from(schema.preferences).where(eq(schema.preferences.id, q.preferenceId))
    : [];
  const previousAnswers = ((q.answers as { text: string }[]) ?? []).map((a) => a.text);

  const { data: ev } = await generateStructured({
    purpose: "QUESTION_EVALUATION",
    tier: "FAST",
    system: QUESTION_EVALUATOR_SYSTEM,
    user: buildQuestionEvaluationPrompt({
      kind: q.kind,
      question: q.question,
      context: q.context,
      previousAnswers,
      answer,
      followUpsLeft,
      hypotheses,
      projects: projects.map((p) => p.name),
    }),
    schema: QuestionEvaluationSchema,
  });

  if (!ev.is_answer && !opts.forceAnswer) return { handled: false };

  const answers = [...((q.answers as unknown[]) ?? []), { text: answer, at: new Date().toISOString(), messageId: messageRowId }];

  if (!ev.sufficient && followUpsLeft > 0 && ev.follow_up_question) {
    const ids = await notifyOwner(`❓ ${ev.follow_up_question}`);
    await db()
      .update(schema.learningQuestions)
      .set({
        answers,
        followUpCount: q.followUpCount + 1,
        lastPromptAt: new Date(),
        telegramMessageId: ids[ids.length - 1] ?? q.telegramMessageId,
        status: "ASKED",
      })
      .where(eq(schema.learningQuestions.id, q.id));
    return { handled: true, status: "FOLLOW_UP" };
  }

  const status = ev.sufficient ? "RESOLVED" : "PARTIALLY_RESOLVED";
  await applyResolution(q, ev, messageRowId);
  await db()
    .update(schema.learningQuestions)
    .set({ answers, status, resolution: ev.answer_summary ?? answer.slice(0, 500), resolvedAt: new Date() })
    .where(eq(schema.learningQuestions.id, q.id));
  await notifyOwner(ev.acknowledgement || (status === "RESOLVED" ? "Tushundim, saqladim." : "Qisman tushundim — keyinchalik boshqa misollar bilan aniqlashtiraman."));
  return { handled: true, status };
}

/** Inline-button choice: deterministic for project / yes-no questions, evaluator otherwise. */
export async function handleOptionChoice(questionId: number, index: number): Promise<AnswerOutcome> {
  const [q] = await db().select().from(schema.learningQuestions).where(eq(schema.learningQuestions.id, questionId));
  if (!q || ["RESOLVED", "DISMISSED"].includes(q.status)) return { handled: false };
  const opt = ((q.options as QOption[]) ?? [])[index];
  if (!opt) return { handled: false };

  if (q.kind === "PROJECT" || q.kind === "NEW_PROJECT") {
    const ev: QuestionEvaluation = {
      is_answer: true,
      sufficient: opt.value !== "__other__",
      answer_summary: opt.label,
      project_name: q.kind === "PROJECT" && !opt.value.startsWith("__") ? opt.value : null,
      yes_no: q.kind === "NEW_PROJECT" ? (opt.value === "yes" ? "YES" : "NO") : null,
      role: null,
      learned: [],
      follow_up_question: null,
      acknowledgement: "",
    };
    if (opt.value === "__other__") {
      await notifyOwner("Qaysi loyiha ekanini yozib yuboring (javob sifatida).");
      await db().update(schema.learningQuestions).set({ status: "ASKED", lastPromptAt: new Date() }).where(eq(schema.learningQuestions.id, q.id));
      return { handled: true, status: "FOLLOW_UP" };
    }
    if (opt.value === "__none__") {
      await db().update(schema.learningQuestions).set({ status: "RESOLVED", resolution: "loyihaga tegishli emas", resolvedAt: new Date() }).where(eq(schema.learningQuestions.id, q.id));
      await notifyOwner("Tushundim — hech qaysi loyihaga bog'lamadim.");
      return { handled: true, status: "RESOLVED" };
    }
    await applyResolution(q, ev, null);
    const answers = [...((q.answers as unknown[]) ?? []), { text: opt.label, at: new Date().toISOString(), via: "button" }];
    await db().update(schema.learningQuestions).set({ answers, status: "RESOLVED", resolution: opt.label, resolvedAt: new Date() }).where(eq(schema.learningQuestions.id, q.id));
    await notifyOwner(q.kind === "NEW_PROJECT" ? (ev.yes_no === "YES" ? "✅ Yangi loyiha saqlandi." : "Tushundim, saqlamadim.") : `✅ "${opt.label}" loyihasiga bog'landi.`);
    return { handled: true, status: "RESOLVED" };
  }
  return handleAnswer(q, opt.label, null, { forceAnswer: true });
}

async function findOrCreateProject(name: string): Promise<number> {
  const all = await db().select().from(schema.projects);
  const n = name.toLowerCase().trim();
  const hit = all.find((p) => p.name.toLowerCase() === n || p.aliases.some((a) => a.toLowerCase() === n));
  if (hit) return hit.id;
  const [row] = await db()
    .insert(schema.projects)
    .values({ name: name.trim(), confirmedByOwner: true })
    .onConflictDoNothing()
    .returning({ id: schema.projects.id });
  if (row) return row.id;
  const [again] = await db().select().from(schema.projects).where(eq(schema.projects.name, name.trim()));
  return again.id;
}

/** Link everything from a batch (and explicit task ids) to a project the owner named. */
export async function linkProject(projectId: number, ctx: { batchId?: number | null; taskIds?: number[] }) {
  const d = db();
  if (ctx.taskIds?.length) {
    await d.update(schema.tasks).set({ projectId, needsClarification: false, updatedAt: new Date() }).where(inArray(schema.tasks.id, ctx.taskIds));
  }
  if (ctx.batchId) {
    const b = ctx.batchId;
    await d.update(schema.messageBatches).set({ projectId }).where(eq(schema.messageBatches.id, b));
    await d.update(schema.tasks).set({ projectId, needsClarification: false }).where(and(eq(schema.tasks.batchId, b), isNull(schema.tasks.projectId)));
    await d.update(schema.commitments).set({ projectId }).where(and(eq(schema.commitments.batchId, b), isNull(schema.commitments.projectId)));
    await d.update(schema.decisions).set({ projectId }).where(and(eq(schema.decisions.batchId, b), isNull(schema.decisions.projectId)));
    await d.update(schema.waitingItems).set({ projectId }).where(and(eq(schema.waitingItems.batchId, b), isNull(schema.waitingItems.projectId)));
    await d.update(schema.meetingsFollowUps).set({ projectId }).where(and(eq(schema.meetingsFollowUps.batchId, b), isNull(schema.meetingsFollowUps.projectId)));
    await d.update(schema.creativeSubmissions).set({ projectId }).where(and(eq(schema.creativeSubmissions.batchId, b), isNull(schema.creativeSubmissions.projectId)));
    await d.update(schema.feedbackEvents).set({ projectId }).where(and(eq(schema.feedbackEvents.batchId, b), isNull(schema.feedbackEvents.projectId)));
    await d
      .update(schema.preferences)
      .set({ projectId, pendingProjectBatchId: null })
      .where(eq(schema.preferences.pendingProjectBatchId, b));
    // chat counterpart becomes a (probable) project member
    const [batch] = await d.select().from(schema.messageBatches).where(eq(schema.messageBatches.id, b));
    if (batch) {
      const [chat] = await d.select().from(schema.chats).where(eq(schema.chats.id, batch.chatId));
      if (chat?.personId) {
        await d.insert(schema.projectMembers).values({ projectId, personId: chat.personId, confidence: 0.8 }).onConflictDoNothing();
      }
    }
  }
}

async function applyResolution(q: QuestionRow, ev: QuestionEvaluation, messageRowId: number | null) {
  const d = db();
  const ctx = (q.context ?? {}) as { taskIds?: number[]; projectName?: string };
  const msgIds = messageRowId ? [messageRowId] : [];

  switch (q.kind) {
    case "PROJECT": {
      if (ev.project_name) {
        const pid = await findOrCreateProject(ev.project_name);
        await linkProject(pid, { batchId: q.batchId, taskIds: [...(ctx.taskIds ?? []), ...(q.taskId ? [q.taskId] : [])] });
      }
      break;
    }
    case "NEW_PROJECT": {
      const name = ev.project_name || ctx.projectName;
      if (ev.yes_no === "YES" && name) {
        const pid = await findOrCreateProject(name);
        if (q.batchId) await linkProject(pid, { batchId: q.batchId });
      }
      break;
    }
    case "ROLE": {
      if (q.personId && (ev.role || ev.answer_summary)) {
        await d
          .update(schema.persons)
          .set({ role: (ev.role || ev.answer_summary)!.slice(0, 120), roleConfidence: 1, roleConfirmed: true, updatedAt: new Date() })
          .where(eq(schema.persons.id, q.personId));
      }
      break;
    }
    case "FEEDBACK_REASON": {
      if (q.feedbackEventId && ev.answer_summary) {
        await d
          .update(schema.feedbackEvents)
          .set({ explicitReason: ev.answer_summary, needsClarification: false, confidence: ev.sufficient ? 0.95 : 0.6 })
          .where(eq(schema.feedbackEvents.id, q.feedbackEventId));
      }
      break;
    }
    case "PREFERENCE": {
      if (q.preferenceId && ev.yes_no === "YES") await setOwnerVerdict(q.preferenceId, "CONFIRM", q.id);
      if (q.preferenceId && ev.yes_no === "NO") await setOwnerVerdict(q.preferenceId, "REJECT", q.id);
      break;
    }
    default:
      if (ev.answer_summary) await d.insert(schema.ownerNotes).values({ text: `${q.question} → ${ev.answer_summary}`, projectId: q.projectId, sourceMessageId: messageRowId });
  }

  // Owner-stated learnings are owner-confirmed.
  for (const l of ev.learned ?? []) {
    try {
      if (l.rejects_preference_id) {
        await setOwnerVerdict(l.rejects_preference_id, "REJECT", q.id);
        continue;
      }
      if (l.confirms_preference_id) {
        await setOwnerVerdict(l.confirms_preference_id, "CONFIRM", q.id);
        continue;
      }
      let projectId: number | null = null;
      if (l.project_scoped) {
        projectId = q.projectId ?? null;
        if (!projectId && q.feedbackEventId) {
          const [fe] = await d.select().from(schema.feedbackEvents).where(eq(schema.feedbackEvents.id, q.feedbackEventId));
          projectId = fe?.projectId ?? null;
        }
      }
      await addEvidence({
        create: {
          scope: l.project_scoped && projectId ? "PROJECT" : l.scope,
          projectId,
          statement: l.statement,
          pendingProjectBatchId: l.project_scoped && !projectId ? q.batchId : null,
        },
        polarity: "SUPPORTS",
        messageIds: msgIds,
        source: "OWNER_ANSWER",
        learningQuestionId: q.id,
        feedbackEventId: q.feedbackEventId,
        confirm: ev.sufficient,
      });
    } catch (e) {
      log.warn("failed to store learned item", { err: e, questionId: q.id });
    }
  }
}
