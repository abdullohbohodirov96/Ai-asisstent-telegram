import { z } from "zod";

/**
 * BATCH ANALYSIS — one call per (chat × 5-minute window).
 * Extracts work objects AND learning signals about the owner, with confidence
 * and evidence ids on every inferred object. Guesses are never facts.
 */

const Conf = z.number().min(0).max(1);
const Ev = z.array(z.number().int()).describe("messages.id values (the numbers in [#id]) that support this item");
const Priority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const PersonRef = z
  .string()
  .describe('"OWNER" (Abdulloh), "COUNTERPART" (the other person in this chat), or a person name mentioned in the text');

export const Scope = z.enum(["GLOBAL", "PROJECT", "PERSON", "SCENARIO", "DESIGN", "VIDEO", "MANAGEMENT", "COMMUNICATION"]);

export const BatchAnalysisSchema = z.object({
  summary: z.string().describe("1-2 sentence neutral summary in Uzbek (Latin)"),
  importance: Conf.describe("0 = small talk, 1 = critical business matter"),
  project: z.object({
    existing_project_id: z.number().int().nullable().describe("id from KNOWN PROJECTS only when clearly this project"),
    name_mentioned: z.string().nullable(),
    confidence: Conf,
    needs_clarification: z.boolean(),
    is_new_project_candidate: z.boolean().describe("true only if a clearly distinct, not-yet-known project is discussed"),
    evidence_message_ids: Ev,
  }),
  people: z.array(
    z.object({
      ref: PersonRef,
      telegram_user_id: z.number().int().nullable(),
      role_guess: z.string().nullable().describe("videograf, dizayner, manager, mijoz, ..."),
      role_confidence: Conf,
      company: z.string().nullable(),
      evidence_message_ids: Ev,
    }),
  ),
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string().nullable(),
      owner: PersonRef.describe("who must DO the task"),
      assigned_by: PersonRef,
      deadline_iso: z.string().nullable().describe("ISO 8601 with +05:00 offset, resolved from relative words using NOW"),
      remind_at_iso: z.string().nullable(),
      priority: Priority,
      status: z.enum(["INBOX", "TODO", "IN_PROGRESS", "WAITING", "SUBMITTED", "REVISION", "DONE", "CANCELLED"]),
      existing_task_id: z.number().int().nullable().describe("id from ACTIVE TASKS if this updates an existing task"),
      confidence: Conf,
      evidence_message_ids: Ev,
    }),
  ),
  commitments: z.array(
    z.object({
      who: PersonRef,
      to_whom: PersonRef,
      what: z.string(),
      due_iso: z.string().nullable(),
      confidence: Conf,
      evidence_message_ids: Ev,
    }),
  ),
  decisions: z.array(z.object({ what: z.string(), why: z.string().nullable(), confidence: Conf, evidence_message_ids: Ev })),
  waiting_items: z.array(
    z.object({
      direction: z.enum(["OWNER_WAITS", "WAITS_FOR_OWNER"]),
      person: PersonRef,
      what: z.string(),
      due_iso: z.string().nullable(),
      confidence: Conf,
      evidence_message_ids: Ev,
    }),
  ),
  followups: z.array(
    z.object({
      title: z.string(),
      kind: z.enum(["MEETING", "CALL", "FOLLOW_UP"]),
      when_iso: z.string().nullable(),
      needs_clarification: z.boolean(),
      confidence: Conf,
      evidence_message_ids: Ev,
    }),
  ),
  unanswered_important: z.array(
    z.object({ message_id: z.number().int(), why: z.string(), urgency: z.enum(["LOW", "MEDIUM", "HIGH"]) }),
  ),
  creative_submissions: z.array(
    z.object({
      kind: z.enum(["SCENARIO", "DESIGN", "VIDEO", "TEXT", "TASK_RESULT", "OTHER"]),
      description: z.string(),
      submitted_by: PersonRef,
      message_id: z.number().int(),
      confidence: Conf,
    }),
  ),
  owner_feedback: z.array(
    z.object({
      submission_index: z.number().int().nullable().describe("index in creative_submissions of THIS batch, else null"),
      subject_kind: z.enum(["SCENARIO", "DESIGN", "VIDEO", "TEXT", "TASK", "RESULT", "OTHER"]),
      reaction: z.enum(["APPROVE", "REJECT", "REVISION", "NEUTRAL"]),
      explicit_reason: z.string().nullable().describe("ONLY what Abdulloh literally said as the reason; null if he gave none"),
      inferred_reason: z.string().nullable().describe("your hypothesis, phrased as 'bo'lishi mumkin'"),
      confidence: Conf,
      evidence_message_ids: Ev,
    }),
  ),
  preference_evidence: z.array(
    z.object({
      scope: Scope,
      project_scoped: z.boolean().describe("true if this applies only to the batch project, not globally"),
      matches_preference_id: z.number().int().nullable().describe("id from KNOWN PREFERENCES if the same idea"),
      polarity: z.enum(["SUPPORTS", "CONTRADICTS", "NEW"]),
      statement: z.string().describe("hypothesis phrased cautiously in Uzbek"),
      is_explicit: z.boolean().describe("Abdulloh stated it directly"),
      confidence: Conf,
      evidence_message_ids: Ev,
    }),
  ),
  risks: z.array(z.object({ description: z.string(), severity: z.enum(["LOW", "MEDIUM", "HIGH"]), evidence_message_ids: Ev })),
  next_actions: z.array(z.object({ action: z.string(), for_owner: z.boolean() })),
  clarification_questions: z.array(
    z.object({
      kind: z.enum(["PROJECT", "NEW_PROJECT", "ROLE", "FEEDBACK_REASON", "PREFERENCE", "OTHER"]),
      question: z.string().describe("ONE short, concrete question to Abdulloh in Uzbek Latin"),
      importance: Conf,
      related_task_index: z.number().int().nullable(),
      related_feedback_index: z.number().int().nullable(),
      related_person_ref: z.string().nullable(),
      evidence_message_ids: Ev,
    }),
  ),
  person_summary_update: z.string().nullable().describe("updated rolling summary of COUNTERPART (<=500 chars) or null if nothing new"),
  project_summary_update: z.string().nullable().describe("updated rolling summary of the project (<=500 chars) or null"),
});

export type BatchAnalysis = z.infer<typeof BatchAnalysisSchema>;

export const BATCH_ANALYSIS_SYSTEM = `You are the analysis engine of "Abdulloh AI Assistant", a private AI Chief of Staff for Abdulloh (the OWNER).
You read ONE 5-minute window of ONE Telegram Business chat between Abdulloh and another person (COUNTERPART).
Chats may be in Uzbek (Latin or Cyrillic), Russian, Arabic or mixed. Understand all; write every human-readable output string in Uzbek Latin.

Your job has two halves:
A) WORK EXTRACTION: tasks, assignments, deadlines, reminders, commitments, decisions, waiting-for items, meetings/follow-ups, important unanswered messages, creative submissions, risks, next actions.
B) LEARNING ABOUT ABDULLOH: how he communicates, manages, delegates, decides, and his creative/scenario/design/video taste — globally and per project.

HARD RULES
1. Never state a guess as a fact. Every inferred object carries "confidence" (0..1) and "evidence_message_ids" (the [#id] numbers). Use only ids that appear in THIS BATCH.
2. Project: set existing_project_id ONLY if the text or chat context makes it clear. If unsure: existing_project_id=null, needs_clarification=true, and add a PROJECT clarification question. Never merge aliases on a hunch.
3. If a clearly new project appears, set is_new_project_candidate=true and ask a NEW_PROJECT question ("Bu yangi loyiha ko'rinmoqda: X. Yangi project sifatida saqlaymi?"). Never invent projects.
4. Deadlines: resolve relative words ("ertaga", "juma kuni", "завтра", "kechgacha") against NOW in Asia/Tashkent and output ISO 8601 with +05:00. If no time is given use 18:00 local. If ambiguous, leave null.
5. owner/assigned_by: "OWNER" = Abdulloh, "COUNTERPART" = the other chat member, otherwise the exact name used. Example: Abdulloh writes "Bobur, ertaga video tayyor bo'lsin" → task owner "COUNTERPART" (if chatting with Bobur) or "Bobur", assigned_by "OWNER", deadline tomorrow 18:00.
6. Feedback learning: when Abdulloh reacts to a scenario/design/video/text/result, record owner_feedback. explicit_reason = only his literal reason. If he gave no clear reason (e.g. "Bunaqa bo'midi, juda oddiy"), put your idea in inferred_reason as a hypothesis ("generic deb hisoblagan bo'lishi mumkin"), keep confidence LOW (<=0.4) and add a FEEDBACK_REASON clarification question such as "Al-Bayan ssenariysini rad qildingiz. Aynan nimasi yoqmadi?".
7. Preference evidence: ONE event is never a rule. Phrase statements cautiously ("... afzal ko'rishi mumkin"). If it matches a KNOWN PREFERENCE use matches_preference_id with SUPPORTS or CONTRADICTS; otherwise NEW. Mark project_scoped=true when it only concerns this project — never generalise a project taste to GLOBAL.
8. Roles of people: only guess from evidence; if role_confidence < 0.6 and the role matters, ask a ROLE question.
9. clarification_questions: at most 3, only genuinely useful ones, each ONE concrete question. Prefer multiple-choice style wording.
10. unanswered_important: messages TO Abdulloh that need his answer and got none inside this window.
11. Do not include chain-of-thought. Short rationales only.
12. Empty arrays are fine. Do not pad.`;

export interface BatchContext {
  nowIso: string;
  chatTitle: string;
  counterpart: { name: string; telegramUserId: number | null; role: string | null; summary: string | null } | null;
  projects: { id: number; name: string; aliases: string[]; summary: string | null }[];
  activeTasks: { id: number; title: string; owner: string | null; deadline: string | null; status: string }[];
  preferences: { id: number; scope: string; project: string | null; statement: string; status: string; confidence: number }[];
  recentMessages: string[];
  batchMessages: string[];
}

export function buildBatchAnalysisPrompt(c: BatchContext): string {
  const lines: string[] = [];
  lines.push(`NOW: ${c.nowIso} (Asia/Tashkent)`);
  lines.push(`CHAT: ${c.chatTitle}`);
  if (c.counterpart) {
    lines.push(
      `COUNTERPART: ${c.counterpart.name} (telegram_id=${c.counterpart.telegramUserId ?? "?"}, role=${c.counterpart.role ?? "noma'lum"})` +
        (c.counterpart.summary ? `\nCOUNTERPART MEMORY: ${c.counterpart.summary}` : ""),
    );
  }
  lines.push("\nKNOWN PROJECTS:");
  lines.push(c.projects.length ? c.projects.map((p) => `- id=${p.id} ${p.name} (aliases: ${p.aliases.join(", ") || "-"})${p.summary ? " — " + p.summary : ""}`).join("\n") : "- (hali yo'q)");
  lines.push("\nACTIVE TASKS IN THIS CHAT:");
  lines.push(c.activeTasks.length ? c.activeTasks.map((t) => `- id=${t.id} "${t.title}" owner=${t.owner ?? "?"} deadline=${t.deadline ?? "-"} status=${t.status}`).join("\n") : "- (yo'q)");
  lines.push("\nKNOWN PREFERENCES (hypotheses and confirmed):");
  lines.push(c.preferences.length ? c.preferences.map((p) => `- id=${p.id} [${p.scope}${p.project ? "/" + p.project : ""}] ${p.statement} (${p.status}, ${p.confidence.toFixed(2)})`).join("\n") : "- (yo'q)");
  if (c.recentMessages.length) {
    lines.push("\nEARLIER CONTEXT (already analysed, do NOT extract again):");
    lines.push(c.recentMessages.join("\n"));
  }
  lines.push("\nTHIS BATCH (analyse these):");
  lines.push(c.batchMessages.join("\n"));
  return lines.join("\n");
}
