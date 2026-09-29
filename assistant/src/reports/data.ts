import { and, eq, gte, inArray, isNull, desc, or, notInArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { fmtLocal, localDate, slotTime, startOfLocalDay, nowLocal, type Slot } from "../util/time.js";
import { confidenceLabel } from "../engine/preferences.js";

export const OPEN_TASK = ["INBOX", "TODO", "IN_PROGRESS", "WAITING", "SUBMITTED", "REVISION"];

export type ReportSlot = Slot | "MANUAL";

export function windowFor(slot: ReportSlot, now: Date): { since: Date; until: Date } {
  const today = localDate(now);
  const yesterday = nowLocal(now).minus({ days: 1 }).toISODate()!;
  switch (slot) {
    case "MORNING":
      return { since: slotTime(yesterday, "EVENING").toJSDate(), until: now };
    case "MIDDAY":
      return { since: slotTime(today, "MORNING").toJSDate(), until: now };
    default:
      return { since: startOfLocalDay(now), until: now };
  }
}

type PersonMap = Map<number, { name: string; role: string | null; isOwner: boolean }>;

async function peopleMap(): Promise<PersonMap> {
  const rows = await db().select().from(schema.persons);
  return new Map(rows.map((p) => [p.id, { name: p.name, role: p.role, isOwner: p.isOwner }]));
}
async function projectMap(): Promise<Map<number, string>> {
  const rows = await db().select().from(schema.projects);
  return new Map(rows.map((p) => [p.id, p.name]));
}

/** Messages flagged important+unanswered by analysis that still have no later owner reply in that chat. */
export async function unansweredImportant(now: Date, lookbackDays = 3) {
  const d = db();
  const results = await d
    .select({ output: schema.analysisResults.output, batchId: schema.analysisResults.batchId, chatId: schema.messageBatches.chatId })
    .from(schema.analysisResults)
    .innerJoin(schema.messageBatches, eq(schema.messageBatches.id, schema.analysisResults.batchId))
    .where(gte(schema.analysisResults.createdAt, new Date(now.getTime() - lookbackDays * 86400_000)));
  const out: { messageId: number; chat: string; from: string; text: string; why: string; urgency: string; at: string }[] = [];
  for (const r of results) {
    const items = ((r.output as any)?.unanswered_important ?? []) as { message_id: number; why: string; urgency: string }[];
    for (const it of items) {
      const [m] = await d.select().from(schema.messages).where(and(eq(schema.messages.id, it.message_id), isNull(schema.messages.deletedAt)));
      if (!m) continue;
      const [reply] = await d
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(and(eq(schema.messages.chatId, m.chatId), eq(schema.messages.direction, "OUTGOING"), gte(schema.messages.sentAt, m.sentAt)))
        .limit(1);
      if (reply) continue;
      const [chat] = await d.select().from(schema.chats).where(eq(schema.chats.id, m.chatId));
      out.push({
        messageId: m.id,
        chat: chat?.title ?? "?",
        from: m.senderName ?? "?",
        text: (m.transcript ?? m.text ?? `[${m.mediaType}]`).slice(0, 160),
        why: it.why,
        urgency: it.urgency,
        at: fmtLocal(m.sentAt),
      });
    }
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>;
  return out.sort((a, b) => (rank[a.urgency] ?? 3) - (rank[b.urgency] ?? 3)).slice(0, 15);
}

export async function gatherReportData(slot: ReportSlot, now: Date = new Date(), sinceOverride?: Date) {
  const d = db();
  const w = windowFor(slot, now);
  const since = sinceOverride && sinceOverride < w.since ? sinceOverride : w.since;
  const people = await peopleMap();
  const projects = await projectMap();
  const pname = (id: number | null) => (id ? people.get(id)?.name ?? null : null);
  const prj = (id: number | null) => (id ? projects.get(id) ?? null : null);

  const batches = await d
    .select({ summary: schema.analysisResults.summary, importance: schema.analysisResults.importance, output: schema.analysisResults.output, chatId: schema.messageBatches.chatId, projectId: schema.messageBatches.projectId, at: schema.messageBatches.windowStart })
    .from(schema.analysisResults)
    .innerJoin(schema.messageBatches, eq(schema.messageBatches.id, schema.analysisResults.batchId))
    .where(gte(schema.analysisResults.createdAt, since))
    .orderBy(desc(schema.analysisResults.importance))
    .limit(30);
  const chats = new Map((await d.select().from(schema.chats)).map((c) => [c.id, c.title ?? "?"]));

  const openTasks = await d.select().from(schema.tasks).where(inArray(schema.tasks.status, OPEN_TASK)).orderBy(schema.tasks.deadline).limit(60);
  const doneInWindow = await d.select().from(schema.tasks).where(and(eq(schema.tasks.status, "DONE"), gte(schema.tasks.updatedAt, since))).limit(30);
  const createdInWindow = await d.select({ id: schema.tasks.id }).from(schema.tasks).where(gte(schema.tasks.createdAt, since));
  const ownerId = [...people.entries()].find(([, p]) => p.isOwner)?.[0] ?? null;

  const taskView = (t: typeof openTasks[number]) => ({
    id: t.id,
    title: t.title,
    owner: t.ownerNameText ?? pname(t.ownerPersonId),
    assigned_by: pname(t.assignedByPersonId),
    project: prj(t.projectId) ?? (t.needsClarification ? "(loyiha noma'lum)" : null),
    status: t.status,
    priority: t.priority,
    deadline: t.deadline ? fmtLocal(t.deadline) : null,
    overdue: Boolean(t.deadline && t.deadline < now),
    confidence: confidenceLabel(t.confidence),
  });

  const waiting = await d.select().from(schema.waitingItems).where(eq(schema.waitingItems.status, "OPEN")).orderBy(desc(schema.waitingItems.createdAt)).limit(30);
  const commitments = await d.select().from(schema.commitments).where(eq(schema.commitments.status, "OPEN")).orderBy(schema.commitments.dueAt).limit(30);
  const followups = await d.select().from(schema.meetingsFollowUps).where(eq(schema.meetingsFollowUps.status, "OPEN")).orderBy(schema.meetingsFollowUps.scheduledAt).limit(20);
  const submissions = await d.select().from(schema.creativeSubmissions).where(gte(schema.creativeSubmissions.createdAt, since)).limit(20);
  const feedback = await d.select().from(schema.feedbackEvents).where(gte(schema.feedbackEvents.createdAt, since)).limit(20);
  const learnings = await d
    .select()
    .from(schema.preferences)
    .where(and(or(gte(schema.preferences.createdAt, since), gte(schema.preferences.updatedAt, since)), notInArray(schema.preferences.status, ["REJECTED"])))
    .orderBy(desc(schema.preferences.confidence))
    .limit(12);
  const questions = await d
    .select()
    .from(schema.learningQuestions)
    .where(inArray(schema.learningQuestions.status, ["OPEN", "ASKED", "PARTIALLY_RESOLVED"]))
    .orderBy(desc(schema.learningQuestions.importance))
    .limit(5);
  const activeProjects = await d.select().from(schema.projects).where(eq(schema.projects.status, "ACTIVE"));

  const risks: { description: string; severity: string; chat: string }[] = [];
  const nextActions: string[] = [];
  for (const b of batches) {
    const o = b.output as any;
    for (const r of o?.risks ?? []) risks.push({ description: r.description, severity: r.severity, chat: chats.get(b.chatId) ?? "?" });
    for (const n of o?.next_actions ?? []) if (n.for_owner) nextActions.push(n.action);
  }

  const tasksOpen = openTasks.map(taskView);
  return {
    slot,
    period: { since: fmtLocal(since, "dd.LL HH:mm"), until: fmtLocal(now, "dd.LL HH:mm") },
    stats: {
      analysed_conversations: batches.length,
      tasks_created: createdInWindow.length,
      tasks_done: doneInWindow.length,
      open_tasks: tasksOpen.length,
      overdue: tasksOpen.filter((t) => t.overdue).length,
    },
    activity: batches.slice(0, 20).map((b) => ({ chat: chats.get(b.chatId), project: prj(b.projectId), at: fmtLocal(b.at, "HH:mm"), importance: Math.round(b.importance * 10) / 10, summary: b.summary })),
    owner_tasks: tasksOpen.filter((t) => ownerId && openTasks.find((x) => x.id === t.id)?.ownerPersonId === ownerId),
    delegated_tasks: tasksOpen.filter((t) => !(ownerId && openTasks.find((x) => x.id === t.id)?.ownerPersonId === ownerId)),
    done_tasks: doneInWindow.map((t) => ({ title: t.title, owner: t.ownerNameText ?? pname(t.ownerPersonId), project: prj(t.projectId) })),
    waiting_for: waiting.map((w) => ({ direction: w.direction === "OWNER_WAITS" ? "Abdulloh kutyapti" : "Abdulloh'dan kutilyapti", person: w.personText ?? pname(w.personId), what: w.what, due: w.dueAt ? fmtLocal(w.dueAt) : null, overdue: Boolean(w.dueAt && w.dueAt < now), project: prj(w.projectId) })),
    unanswered_important: await unansweredImportant(now),
    commitments: commitments.map((c) => ({ who: c.whoText ?? pname(c.personId), to: c.toText ?? pname(c.toPersonId), what: c.what, due: c.dueAt ? fmtLocal(c.dueAt) : null, overdue: Boolean(c.dueAt && c.dueAt < now), by_owner: c.personId === ownerId })),
    followups: followups.map((f) => ({ title: f.title, kind: f.kind, when: f.scheduledAt ? fmtLocal(f.scheduledAt) : "aniqlanmagan", needs_clarification: f.needsClarification, with: pname(f.personId) })),
    creative: {
      submitted: submissions.map((s) => ({ kind: s.kind, description: s.description, by: pname(s.submittedByPersonId), project: prj(s.projectId), status: s.status })),
      owner_feedback: feedback.map((f) => ({ kind: f.subjectKind, reaction: f.reaction, reason: f.explicitReason, hypothesis: f.explicitReason ? null : f.inferredReason, project: prj(f.projectId) })),
    },
    learnings: learnings.map((p) => ({ observation: p.statement, evidence_count: p.evidenceCount, confidence: `${confidenceLabel(p.confidence)} (${p.confidence.toFixed(2)})`, status: p.status, confirmed_by_owner: p.confirmedByOwner, scope: p.projectId ? `loyiha: ${prj(p.projectId)}` : p.scope })),
    open_questions: questions.map((q) => ({ question: q.question, kind: q.kind, status: q.status })),
    risks: risks.slice(0, 10),
    suggested_next_actions: [...new Set(nextActions)].slice(0, 8),
    projects: activeProjects.map((p) => ({
      name: p.name,
      summary: p.summary,
      open_tasks: tasksOpen.filter((t) => t.project === p.name).length,
      overdue: tasksOpen.filter((t) => t.project === p.name && t.overdue).length,
    })),
  };
}

export type ReportData = Awaited<ReturnType<typeof gatherReportData>>;

