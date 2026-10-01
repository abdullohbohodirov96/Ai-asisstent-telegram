import { and, eq, inArray, isNull, notInArray, sql, desc, lt } from "drizzle-orm";
import { config } from "../config/env.js";
import { db, schema, type DB } from "../db/client.js";
import { generateStructured, BudgetPausedError } from "../ai/client.js";
import { BATCH_ANALYSIS_SYSTEM, BatchAnalysisSchema, buildBatchAnalysisPrompt, type BatchAnalysis } from "../ai/prompts/batch-analysis.js";
import { addEvidence } from "./preferences.js";
import { createQuestion, type QOption } from "./questions.js";
import { transcriptionProvider } from "../transcription/provider.js";
import { downloadFileForAnalysis } from "./files.js";
import { fmtLocal, nowLocal, parseAiDate } from "../util/time.js";
import { backoffMs } from "../util/retry.js";
import { errorText, log } from "../util/log.js";

const MAX_BATCH_ATTEMPTS = 8;
const OPEN_TASK_STATUSES = ["INBOX", "TODO", "IN_PROGRESS", "WAITING", "SUBMITTED", "REVISION"];

type Batch = typeof schema.messageBatches.$inferSelect;
type Msg = typeof schema.messages.$inferSelect;
type Chat = typeof schema.chats.$inferSelect;

export async function recoverStuckBatches(): Promise<void> {
  await db()
    .update(schema.messageBatches)
    .set({ status: "PENDING", lockedAt: null })
    .where(and(eq(schema.messageBatches.status, "PROCESSING"), lt(schema.messageBatches.lockedAt, new Date(Date.now() - 10 * 60_000))));
}

export async function claimNextBatch(): Promise<Batch | null> {
  const res = await db().execute(sql`
    update as_message_batches set status='PROCESSING', locked_at=now(), attempts=attempts+1
    where id = (
      select id from as_message_batches
      where status in ('PENDING','FAILED') and next_attempt_at <= now() and attempts < ${MAX_BATCH_ATTEMPTS}
      order by window_start asc
      limit 1 for update skip locked
    )
    returning id`);
  const id = (res.rows[0] as { id?: number } | undefined)?.id;
  if (!id) return null;
  const [b] = await db().select().from(schema.messageBatches).where(eq(schema.messageBatches.id, id));
  return b ?? null;
}

/** Process up to `max` batches. Returns number analysed successfully. */
export async function analyzePendingBatches(max = 5): Promise<number> {
  let ok = 0;
  for (let i = 0; i < max; i++) {
    const batch = await claimNextBatch();
    if (!batch) break;
    try {
      await analyzeBatch(batch);
      ok++;
    } catch (e) {
      if (e instanceof BudgetPausedError) {
        await db()
          .update(schema.messageBatches)
          .set({ status: "PENDING", attempts: Math.max(0, batch.attempts - 1), nextAttemptAt: new Date(Date.now() + 60 * 60_000), lockedAt: null, error: "budget paused" })
          .where(eq(schema.messageBatches.id, batch.id));
        break;
      }
      log.error("batch analysis failed", { batchId: batch.id, attempts: batch.attempts, err: e });
      await db()
        .update(schema.messageBatches)
        .set({ status: "FAILED", lockedAt: null, error: errorText(e), nextAttemptAt: new Date(Date.now() + backoffMs(batch.attempts)) })
        .where(eq(schema.messageBatches.id, batch.id));
      await db().update(schema.messages).set({ analysisStatus: "FAILED" }).where(eq(schema.messages.batchId, batch.id));
    }
  }
  return ok;
}

function renderMessage(m: Msg, ownerName: string): string {
  const who = m.direction === "OUTGOING" ? `${ownerName} (OWNER)` : m.senderName ?? "?";
  const body = m.transcript ? `[voice] ${m.transcript}` : m.text ?? (m.mediaType ? `[${m.mediaType}]` : "");
  const reply = m.replyToMessageId ? ` (reply to tg:${m.replyToMessageId})` : "";
  const edited = m.editedAt ? " (tahrirlangan)" : "";
  return `[#${m.id}] ${fmtLocal(m.sentAt, "dd.LL HH:mm")} ${who}${reply}${edited}: ${body.slice(0, 2000)}`;
}

export async function analyzeBatch(batch: Batch): Promise<BatchAnalysis | null> {
  const d = db();
  // idempotency: an analysis result already exists → just finalise
  const [done] = await d.select({ id: schema.analysisResults.id }).from(schema.analysisResults).where(eq(schema.analysisResults.batchId, batch.id));
  if (done) {
    await finalize(batch.id);
    return null;
  }

  const msgs = await d
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.batchId, batch.id), isNull(schema.messages.deletedAt)))
    .orderBy(schema.messages.sentAt, schema.messages.id);
  if (!msgs.length) {
    await finalize(batch.id);
    return null;
  }
  await d.update(schema.messages).set({ analysisStatus: "PROCESSING" }).where(eq(schema.messages.batchId, batch.id));

  // optional: transcribe voice notes in business chats
  if (config().transcribeBusinessVoice) {
    for (const m of msgs) {
      if ((m.mediaType === "voice" || m.mediaType === "audio") && m.fileId && !m.transcript) {
        try {
          const f = await downloadFileForAnalysis(m.fileId);
          m.transcript = await transcriptionProvider().transcribe(f.data, f.mimeType);
          await d.update(schema.messages).set({ transcript: m.transcript }).where(eq(schema.messages.id, m.id));
        } catch (e) {
          log.warn("business voice transcription failed", { messageId: m.id, err: e });
        }
      }
    }
  }

  const [chat] = await d.select().from(schema.chats).where(eq(schema.chats.id, batch.chatId));
  const counterpart = chat.personId ? (await d.select().from(schema.persons).where(eq(schema.persons.id, chat.personId)))[0] : null;
  const [owner] = await d.select().from(schema.persons).where(eq(schema.persons.isOwner, true));
  const ownerName = owner?.name ?? "Abdulloh";

  const projects = await d.select().from(schema.projects).where(notInArray(schema.projects.status, ["ARCHIVED"]));
  const activeTasks = await d
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.chatId, chat.id), inArray(schema.tasks.status, OPEN_TASK_STATUSES)))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(15);
  const prefs = await d
    .select()
    .from(schema.preferences)
    .where(notInArray(schema.preferences.status, ["REJECTED"]))
    .orderBy(desc(schema.preferences.confidence))
    .limit(20);
  const recent = await d
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.chatId, chat.id), lt(schema.messages.sentAt, msgs[0].sentAt), isNull(schema.messages.deletedAt)))
    .orderBy(desc(schema.messages.sentAt))
    .limit(6);

  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const personName = async (id: number | null) => (id ? (await d.select({ n: schema.persons.name }).from(schema.persons).where(eq(schema.persons.id, id)))[0]?.n ?? null : null);

  const prompt = buildBatchAnalysisPrompt({
    nowIso: nowLocal().toISO()!,
    chatTitle: chat.title ?? "chat",
    counterpart: counterpart ? { name: counterpart.name, telegramUserId: counterpart.telegramUserId, role: counterpart.role, summary: counterpart.summary } : null,
    projects: projects.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, summary: p.summary })),
    activeTasks: await Promise.all(
      activeTasks.map(async (t) => ({ id: t.id, title: t.title, owner: t.ownerNameText ?? (await personName(t.ownerPersonId)), deadline: t.deadline ? fmtLocal(t.deadline) : null, status: t.status })),
    ),
    preferences: prefs.map((p) => ({ id: p.id, scope: p.scope, project: p.projectId ? projName.get(p.projectId) ?? null : null, statement: p.statement, status: p.status, confidence: p.confidence })),
    recentMessages: recent.reverse().map((m) => renderMessage(m, ownerName)),
    batchMessages: msgs.map((m) => renderMessage(m, ownerName)),
  });

  const { data, model } = await generateStructured({
    purpose: "BATCH_ANALYSIS",
    tier: "FAST",
    system: BATCH_ANALYSIS_SYSTEM,
    user: prompt,
    schema: BatchAnalysisSchema,
    batchId: batch.id,
  });

  await persistAnalysis(batch, chat, msgs, data, model, activeTasks.map((t) => t.id));
  await finalize(batch.id);
  return data;
}

async function finalize(batchId: number) {
  await db().update(schema.messageBatches).set({ status: "DONE", completedAt: new Date(), lockedAt: null, error: null }).where(eq(schema.messageBatches.id, batchId));
  await db().update(schema.messages).set({ analysisStatus: "DONE" }).where(and(eq(schema.messages.batchId, batchId), isNull(schema.messages.deletedAt)));
}

// ---------------------------------------------------------------------------- persistence

const PROJECT_LINK_MIN_CONF = 0.7;

export async function persistAnalysis(batch: Batch, chat: Chat, msgs: Msg[], a: BatchAnalysis, model: string, activeTaskIds: number[]): Promise<void> {
  await db().transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const inserted = await tx
      .insert(schema.analysisResults)
      .values({ batchId: batch.id, model, output: a, importance: a.importance, summary: a.summary })
      .onConflictDoNothing()
      .returning({ id: schema.analysisResults.id });
    if (!inserted.length) return; // already persisted by a concurrent run

    const valid = new Set(msgs.map((m) => m.id));
    const ev = (ids: number[] | undefined) => {
      const f = (ids ?? []).filter((i) => valid.has(i));
      return f.length ? f : msgs.map((m) => m.id);
    };
    const firstEv = (ids: number[] | undefined) => ev(ids)[0] ?? null;

    const [ownerRow] = await tx.select().from(schema.persons).where(eq(schema.persons.isOwner, true));
    const allPeople = await tx.select().from(schema.persons);
    const resolvePerson = (ref: string | null | undefined): { id: number | null; text: string | null } => {
      if (!ref) return { id: null, text: null };
      const r = ref.trim();
      if (r.toUpperCase() === "OWNER") return { id: ownerRow?.id ?? null, text: ownerRow?.name ?? "Abdulloh" };
      if (r.toUpperCase() === "COUNTERPART") {
        const p = allPeople.find((x) => x.id === chat.personId);
        return { id: chat.personId ?? null, text: p?.name ?? null };
      }
      const low = r.toLowerCase().replace(/^@/, "");
      const exact = allPeople.filter((p) => p.name.toLowerCase() === low || p.username?.toLowerCase() === low);
      if (exact.length === 1) return { id: exact[0].id, text: exact[0].name };
      const first = allPeople.filter((p) => p.name.toLowerCase().split(" ")[0] === low.split(" ")[0]);
      // Similar names are NOT merged unless unique; ambiguous → keep text only.
      if (first.length === 1 && exact.length === 0) return { id: first[0].id, text: first[0].name };
      return { id: null, text: r };
    };

    // ---- project
    const projects = await tx.select().from(schema.projects);
    let projectId: number | null = null;
    const pj = a.project;
    if (pj.existing_project_id && pj.confidence >= PROJECT_LINK_MIN_CONF && projects.some((p) => p.id === pj.existing_project_id)) {
      projectId = pj.existing_project_id;
    } else if (pj.name_mentioned && pj.confidence >= PROJECT_LINK_MIN_CONF) {
      const n = pj.name_mentioned.toLowerCase().trim();
      const hit = projects.filter((p) => p.name.toLowerCase() === n || p.aliases.some((al) => al.toLowerCase() === n));
      if (hit.length === 1) projectId = hit[0].id;
    }
    if (!projectId && chat.defaultProjectId) projectId = chat.defaultProjectId;
    if (projectId) await tx.update(schema.messageBatches).set({ projectId }).where(eq(schema.messageBatches.id, batch.id));

    // ---- people (roles are learnings with confidence; confirmed roles are never overwritten)
    for (const p of a.people) {
      const ref = p.telegram_user_id ? allPeople.find((x) => x.telegramUserId === p.telegram_user_id) : null;
      const pid = ref?.id ?? resolvePerson(p.ref).id;
      if (!pid) continue;
      const person = allPeople.find((x) => x.id === pid);
      if (!person || person.isOwner) continue;
      if (p.role_guess && !person.roleConfirmed && p.role_confidence > person.roleConfidence) {
        await tx.update(schema.persons).set({ role: p.role_guess, roleConfidence: p.role_confidence, company: p.company ?? person.company, updatedAt: new Date() }).where(eq(schema.persons.id, pid));
      }
      if (projectId) await tx.insert(schema.projectMembers).values({ projectId, personId: pid, role: p.role_guess, confidence: Math.min(p.role_confidence, pj.confidence) }).onConflictDoNothing();
    }

    // ---- tasks
    const newTaskIds: { id: number; title: string; owner: string | null; index: number }[] = [];
    const existingOpen = await tx.select().from(schema.tasks).where(and(eq(schema.tasks.chatId, chat.id), inArray(schema.tasks.status, OPEN_TASK_STATUSES)));
    for (const [index, t] of a.tasks.entries()) {
      const owner = resolvePerson(t.owner);
      const by = resolvePerson(t.assigned_by);
      const deadline = parseAiDate(t.deadline_iso);
      const remindAt = parseAiDate(t.remind_at_iso);
      const update = t.existing_task_id && activeTaskIds.includes(t.existing_task_id);
      const dup = !update && existingOpen.find((x) => x.title.toLowerCase().trim() === t.title.toLowerCase().trim());
      const targetId = update ? t.existing_task_id! : dup ? dup.id : null;
      if (targetId) {
        await tx
          .update(schema.tasks)
          .set({
            status: t.status,
            deadline: deadline ?? undefined,
            remindAt: remindAt ?? undefined,
            // a new reminder time must fire again even if an earlier one was already sent
            remindedAt: remindAt ? null : undefined,
            completedAt: t.status === "DONE" ? new Date() : undefined,
            evidenceMessageIds: sql`array_cat(${schema.tasks.evidenceMessageIds}, ${sql`ARRAY[${sql.join(ev(t.evidence_message_ids).map((i) => sql`${i}`), sql`, `)}]::int[]`})`,
            updatedAt: new Date(),
          })
          .where(eq(schema.tasks.id, targetId));
        continue;
      }
      const [row] = await tx
        .insert(schema.tasks)
        .values({
          title: t.title,
          description: t.description,
          projectId,
          ownerPersonId: owner.id,
          ownerNameText: owner.text,
          assignedByPersonId: by.id,
          status: t.status,
          priority: t.priority,
          deadline,
          remindAt,
          sourceMessageId: firstEv(t.evidence_message_ids),
          needsClarification: !projectId,
          confidence: t.confidence,
          evidenceMessageIds: ev(t.evidence_message_ids),
          batchId: batch.id,
          chatId: chat.id,
          completedAt: t.status === "DONE" ? new Date() : null,
        })
        .returning({ id: schema.tasks.id });
      newTaskIds.push({ id: row.id, title: t.title, owner: owner.text, index });
    }

    // ---- commitments / decisions / waiting / follow-ups
    for (const c of a.commitments) {
      const who = resolvePerson(c.who);
      const to = resolvePerson(c.to_whom);
      await tx.insert(schema.commitments).values({
        personId: who.id,
        whoText: who.text,
        toPersonId: to.id,
        toText: to.text,
        what: c.what,
        promisedAt: msgs.find((m) => m.id === firstEv(c.evidence_message_ids))?.sentAt ?? null,
        dueAt: parseAiDate(c.due_iso),
        projectId,
        confidence: c.confidence,
        evidenceMessageIds: ev(c.evidence_message_ids),
        batchId: batch.id,
        chatId: chat.id,
      });
    }
    for (const dcs of a.decisions) {
      await tx.insert(schema.decisions).values({ what: dcs.what, why: dcs.why, projectId, decidedAt: msgs[msgs.length - 1].sentAt, confidence: dcs.confidence, evidenceMessageIds: ev(dcs.evidence_message_ids), batchId: batch.id, chatId: chat.id });
    }
    for (const w of a.waiting_items) {
      const p = resolvePerson(w.person);
      await tx.insert(schema.waitingItems).values({ direction: w.direction, personId: p.id, personText: p.text, what: w.what, dueAt: parseAiDate(w.due_iso), projectId, confidence: w.confidence, evidenceMessageIds: ev(w.evidence_message_ids), batchId: batch.id, chatId: chat.id });
    }
    for (const f of a.followups) {
      await tx.insert(schema.meetingsFollowUps).values({
        title: f.title,
        kind: f.kind,
        scheduledAt: parseAiDate(f.when_iso),
        personId: chat.personId,
        projectId,
        needsClarification: f.needs_clarification || !f.when_iso,
        confidence: f.confidence,
        evidenceMessageIds: ev(f.evidence_message_ids),
        batchId: batch.id,
        chatId: chat.id,
      });
    }

    // ---- creative submissions & owner feedback
    const submissionIds: (number | null)[] = [];
    for (const s of a.creative_submissions) {
      const by = resolvePerson(s.submitted_by);
      const [row] = await tx
        .insert(schema.creativeSubmissions)
        .values({
          kind: s.kind,
          description: s.description,
          submittedByPersonId: by.id,
          projectId,
          messageId: valid.has(s.message_id) ? s.message_id : null,
          confidence: s.confidence,
          evidenceMessageIds: ev(valid.has(s.message_id) ? [s.message_id] : []),
          batchId: batch.id,
          chatId: chat.id,
        })
        .returning({ id: schema.creativeSubmissions.id });
      submissionIds.push(row.id);
    }
    const feedbackIds: { id: number; needsReason: boolean; kind: string; index: number }[] = [];
    for (const [index, f] of a.owner_feedback.entries()) {
      const submissionId = f.submission_index != null ? submissionIds[f.submission_index] ?? null : null;
      const needsReason = (f.reaction === "REJECT" || f.reaction === "REVISION") && !f.explicit_reason;
      const [row] = await tx
        .insert(schema.feedbackEvents)
        .values({
          submissionId,
          subjectKind: f.subject_kind,
          reaction: f.reaction,
          explicitReason: f.explicit_reason,
          inferredReason: f.inferred_reason,
          needsClarification: needsReason,
          projectId,
          personId: chat.personId,
          confidence: f.explicit_reason ? Math.max(f.confidence, 0.7) : Math.min(f.confidence, 0.4),
          evidenceMessageIds: ev(f.evidence_message_ids),
          batchId: batch.id,
          chatId: chat.id,
        })
        .returning({ id: schema.feedbackEvents.id });
      feedbackIds.push({ id: row.id, needsReason, kind: f.subject_kind, index });
      if (submissionId) {
        const st = f.reaction === "APPROVE" ? "APPROVED" : f.reaction === "REJECT" ? "REJECTED" : f.reaction === "REVISION" ? "REVISION" : null;
        if (st) await tx.update(schema.creativeSubmissions).set({ status: st }).where(eq(schema.creativeSubmissions.id, submissionId));
      }
    }

    // ---- preference evidence (never a stable rule from one event)
    for (const pe of a.preference_evidence) {
      const projectScoped = pe.project_scoped || pe.scope === "PROJECT";
      await addEvidence(
        {
          preferenceId: pe.polarity !== "NEW" ? pe.matches_preference_id : null,
          create: {
            scope: projectScoped && projectId ? "PROJECT" : pe.scope === "PROJECT" ? "GLOBAL" : pe.scope,
            projectId: projectScoped ? projectId : null,
            personId: pe.scope === "PERSON" ? chat.personId : null,
            statement: pe.statement,
            rationale: null,
            pendingProjectBatchId: projectScoped && !projectId ? batch.id : null,
          },
          polarity: pe.polarity === "CONTRADICTS" ? "CONTRADICTS" : "SUPPORTS",
          messageIds: ev(pe.evidence_message_ids),
          source: pe.is_explicit ? "OWNER_STATEMENT" : "CHAT",
          weight: pe.is_explicit ? 1.5 : Math.max(0.3, Math.min(1, pe.confidence + 0.3)),
          feedbackEventId: feedbackIds[0]?.id ?? null,
        },
        tx,
      );
    }

    // ---- learning questions
    const projectOptions: QOption[] = [
      ...projects.filter((p) => p.status === "ACTIVE").slice(0, 6).map((p) => ({ label: p.name, value: p.name })),
      { label: "Boshqa loyiha (yozaman)", value: "__other__" },
      { label: "Loyihaga tegishli emas", value: "__none__" },
    ];
    const needsProject = !projectId && (newTaskIds.length > 0 || feedbackIds.length > 0 || a.creative_submissions.length > 0 || pj.needs_clarification) && !pj.is_new_project_candidate;
    if (needsProject && (a.importance >= 0.3 || newTaskIds.length)) {
      const single = newTaskIds.length === 1 ? newTaskIds[0] : null;
      const question = single
        ? `${single.owner ? single.owner + "ga" : ""} bergan "${single.title}" vazifangiz qaysi loyiha uchun edi?`.trim()
        : `${chat.title ?? "Bu chat"} bilan ${fmtLocal(batch.windowStart, "HH:mm")} dagi yozishma qaysi loyiha haqida edi?`;
      await createQuestion(
        {
          kind: "PROJECT",
          question: question.charAt(0).toUpperCase() + question.slice(1),
          dedupeKey: `batch-project:${batch.id}`,
          importance: Math.max(0.5, a.importance),
          context: { taskIds: newTaskIds.map((t) => t.id), chat: chat.title, summary: a.summary },
          options: projectOptions,
          taskId: single?.id ?? null,
          batchId: batch.id,
          personId: chat.personId,
        },
        tx,
      );
    }
    if (pj.is_new_project_candidate && pj.name_mentioned) {
      await createQuestion(
        {
          kind: "NEW_PROJECT",
          question: `Bu yangi loyiha ko'rinmoqda: "${pj.name_mentioned}". Yangi project sifatida saqlaymi?`,
          dedupeKey: `newproj:${pj.name_mentioned.toLowerCase().trim()}`,
          importance: Math.max(0.55, a.importance),
          context: { projectName: pj.name_mentioned, summary: a.summary },
          options: [
            { label: "Ha, saqla", value: "yes" },
            { label: "Yo'q", value: "no" },
          ],
          batchId: batch.id,
        },
        tx,
      );
    }
    const aiQ = a.clarification_questions;
    for (const fb of feedbackIds.filter((f) => f.needsReason)) {
      const aiText = aiQ.find((q) => q.kind === "FEEDBACK_REASON" && (q.related_feedback_index == null || q.related_feedback_index === fb.index))?.question;
      const pname = projectId ? projects.find((p) => p.id === projectId)?.name : null;
      await createQuestion(
        {
          kind: "FEEDBACK_REASON",
          question: aiText ?? `${pname ? pname + " " : ""}${kindLabel(fb.kind)}ni rad qildingiz. Aynan nimasi yoqmadi?`,
          dedupeKey: `feedback:${fb.id}`,
          importance: Math.max(0.7, a.importance),
          context: { summary: a.summary, inferred_reason: a.owner_feedback[fb.index]?.inferred_reason },
          feedbackEventId: fb.id,
          projectId,
          batchId: batch.id,
        },
        tx,
      );
    }
    for (const [i, q] of aiQ.entries()) {
      if (q.kind === "PROJECT" || q.kind === "FEEDBACK_REASON" || q.kind === "NEW_PROJECT") continue; // handled deterministically above
      let personId: number | null = null;
      if (q.kind === "ROLE") {
        personId = resolvePerson(q.related_person_ref ?? "COUNTERPART").id;
        const person = allPeople.find((p) => p.id === personId);
        if (!personId || person?.roleConfirmed || person?.isOwner) continue;
      }
      await createQuestion(
        {
          kind: q.kind,
          question: q.question,
          dedupeKey: q.kind === "ROLE" ? `role:${personId}` : `b${batch.id}:${q.kind}:${i}`,
          importance: Math.max(q.importance, a.importance * 0.6),
          context: { summary: a.summary, evidence: ev(q.evidence_message_ids) },
          personId,
          projectId,
          batchId: batch.id,
        },
        tx,
      );
    }

    // ---- rolling memory
    if (a.person_summary_update && chat.personId) {
      await tx.update(schema.persons).set({ summary: a.person_summary_update.slice(0, 800), updatedAt: new Date() }).where(eq(schema.persons.id, chat.personId));
    }
    if (a.project_summary_update && projectId) {
      await tx.update(schema.projects).set({ summary: a.project_summary_update.slice(0, 800), updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
    }
  });
}

function kindLabel(k: string): string {
  return ({ SCENARIO: "ssenariy", DESIGN: "dizayn", VIDEO: "video", TEXT: "matn", TASK: "vazifa natijasi", RESULT: "natija" } as Record<string, string>)[k] ?? "ish";
}
