import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { config } from "../config/env.js";
import { db, schema } from "../db/client.js";
import { generateStructured } from "../ai/client.js";
import { OWNER_ASSISTANT_SYSTEM, OwnerAssistantSchema, buildOwnerAssistantPrompt, type OwnerAssistantOutput } from "../ai/prompts/owner-assistant.js";
import { transcriptionProvider } from "../transcription/provider.js";
import { downloadFileForAnalysis } from "../engine/files.js";
import { findQuestionForReply, handleAnswer, handleOptionChoice, askNextQuestion } from "../engine/questions.js";
import { addEvidence, setOwnerVerdict, confidenceLabel } from "../engine/preferences.js";
import { answerOwnerCallback } from "../telegram/api.js";
import { OPEN_TASK } from "../reports/data.js";
import { handleCommand } from "./commands.js";
import { notifyOwner } from "./notify.js";
import { fmtLocal, nowLocal, parseAiDate } from "../util/time.js";
import { log } from "../util/log.js";

/** Owner ↔ assistant private chat. The ONLY conversation the bot participates in. */

export async function onOwnerMessage(messageRowId: number, raw: any): Promise<void> {
  let text: string = raw.text ?? raw.caption ?? "";

  if (raw.voice || raw.audio || raw.video_note) {
    const fileId = raw.voice?.file_id ?? raw.audio?.file_id ?? raw.video_note?.file_id;
    try {
      const f = await downloadFileForAnalysis(fileId);
      const transcript = await transcriptionProvider().transcribe(f.data, f.mimeType);
      await db().update(schema.messages).set({ transcript }).where(eq(schema.messages.id, messageRowId));
      await notifyOwner(`🎙 Transkripsiya:\n“${transcript}”`);
      if (!transcript || transcript === "[eshitilmadi]") return;
      text = transcript;
    } catch (e) {
      log.error("owner voice transcription failed", { err: e });
      await notifyOwner("🎙 Ovozli xabarni transkripsiya qila olmadim. Iltimos, qayta yuboring yoki matn bilan yozing.");
      return;
    }
  }

  if (!text.trim()) return;
  if (text.trim().startsWith("/")) {
    await handleCommand(text);
    return;
  }

  // 1) Is it an answer to a learning question?
  // Judge "is a question awaiting an answer" at the time the owner wrote, not when the
  // (possibly retried / delayed after host sleep) update is processed.
  const writtenAt = typeof raw.date === "number" ? new Date(raw.date * 1000) : new Date();
  const q = await findQuestionForReply(raw.reply_to_message?.message_id ?? null, writtenAt);
  if (q) {
    const explicitReply = raw.reply_to_message?.message_id && raw.reply_to_message.message_id === q.telegramMessageId;
    const outcome = await handleAnswer(q, text, messageRowId, { forceAnswer: Boolean(explicitReply) });
    if (outcome.handled) {
      if (outcome.status !== "FOLLOW_UP") await askNextQuestion();
      return;
    }
  }

  // 2) Direct request / conversation
  await answerOwner(text, messageRowId);
}

export async function onOwnerCallback(cb: any): Promise<void> {
  const data: string = cb.data ?? "";
  const m = data.match(/^q:(\d+):(\d+)$/);
  await answerOwnerCallback(cb.id, cb.from.id).catch(() => undefined);
  if (!m) return;
  const outcome = await handleOptionChoice(Number(m[1]), Number(m[2]));
  if (outcome.handled && outcome.status !== "FOLLOW_UP") await askNextQuestion();
}

// ---------------------------------------------------------------- owner assistant

async function buildOwnerContext(message: string): Promise<string> {
  const d = db();
  const now = new Date();
  const people = new Map((await d.select().from(schema.persons)).map((p) => [p.id, p]));
  const projects = await d.select().from(schema.projects).where(notInArray(schema.projects.status, ["ARCHIVED"]));
  const pn = new Map(projects.map((p) => [p.id, p.name]));
  const tasks = await d.select().from(schema.tasks).where(inArray(schema.tasks.status, OPEN_TASK)).orderBy(schema.tasks.deadline).limit(25);
  const waiting = await d.select().from(schema.waitingItems).where(eq(schema.waitingItems.status, "OPEN")).limit(15);
  const prefs = await d.select().from(schema.preferences).where(notInArray(schema.preferences.status, ["REJECTED"])).orderBy(desc(schema.preferences.confidence)).limit(15);
  const [profile] = await d.select().from(schema.userProfile).where(eq(schema.userProfile.telegramUserId, config().telegram.ownerId));

  // Explainability: attach evidence for preferences (dates + short snippets), extra detail if "#id" is mentioned.
  const mentioned = new Set([...message.matchAll(/#(\d+)/g)].map((x) => Number(x[1])));
  const prefLines: string[] = [];
  for (const p of prefs) {
    const evs = await d
      .select()
      .from(schema.learningEvidence)
      .where(and(eq(schema.learningEvidence.preferenceId, p.id), eq(schema.learningEvidence.active, true)))
      .orderBy(desc(schema.learningEvidence.createdAt))
      .limit(mentioned.has(p.id) ? 8 : 3);
    const evText: string[] = [];
    for (const e of evs) {
      const ids = e.messageIds.slice(0, 2);
      const msgs = ids.length ? await d.select().from(schema.messages).where(inArray(schema.messages.id, ids)) : [];
      const snippet = msgs.map((m) => `"${(m.transcript ?? m.text ?? "").slice(0, 90)}"`).join(" ");
      evText.push(`${fmtLocal(e.createdAt, "dd.LL")} ${e.polarity === "SUPPORTS" ? "+" : "−"} ${e.source}${snippet ? " " + snippet : ""}`);
    }
    prefLines.push(
      `#${p.id} [${p.projectId ? pn.get(p.projectId) : p.scope}] ${p.statement} | ${p.status} ${confidenceLabel(p.confidence)} ${p.confidence.toFixed(2)} | +${p.supportingCount}/−${p.contradictingCount} | ${p.confirmedByOwner ? "OWNER-CONFIRMED" : "hypothesis"}\n   evidence: ${evText.join(" ; ") || "-"}`,
    );
  }

  const out: string[] = [];
  out.push(`PROJECTS: ${projects.map((p) => `${p.name}${p.summary ? ` (${p.summary.slice(0, 120)})` : ""}`).join(" | ") || "-"}`);
  out.push(
    `OPEN TASKS:\n${tasks.map((t) => `#${t.id} ${t.title} | ${t.ownerNameText ?? people.get(t.ownerPersonId ?? -1)?.name ?? "?"} | ${t.projectId ? pn.get(t.projectId) : "loyiha?"} | ${t.deadline ? fmtLocal(t.deadline) + (t.deadline < now ? " OVERDUE" : "") : "-"} | ${t.status} | conf ${t.confidence.toFixed(2)}`).join("\n") || "-"}`,
  );
  out.push(`WAITING: ${waiting.map((w) => `${w.direction} ${w.personText ?? people.get(w.personId ?? -1)?.name ?? "?"}: ${w.what}`).join(" | ") || "-"}`);
  out.push(`PEOPLE: ${[...people.values()].filter((p) => !p.isOwner).slice(0, 20).map((p) => `${p.name}${p.role ? ` (${p.role}${p.roleConfirmed ? "" : "?"})` : ""}`).join(", ") || "-"}`);
  out.push(`PREFERENCES WITH EVIDENCE:\n${prefLines.join("\n") || "-"}`);
  if (profile) {
    const dims = [profile.communicationStyle, profile.managementStyle, profile.delegationStyle, profile.decisionStyle, profile.creativeTaste, profile.scenarioTaste, profile.designTaste, profile.videoTaste].filter(Boolean);
    if (dims.length) out.push(`OWNER PROFILE: ${dims.join(" | ")}`);
  }
  return out.join("\n\n");
}

async function recentDialog(limit = 8): Promise<string[]> {
  const rows = await db()
    .select()
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.chats.id, schema.messages.chatId))
    .where(eq(schema.chats.kind, "ASSISTANT"))
    .orderBy(desc(schema.messages.sentAt), desc(schema.messages.id))
    .limit(limit);
  return rows
    .reverse()
    .slice(0, -1) // exclude the current message
    .map((r) => `${r.as_messages.direction === "OWNER_TO_ASSISTANT" ? "Abdulloh" : "Assistant"}: ${(r.as_messages.transcript ?? r.as_messages.text ?? "").slice(0, 300)}`);
}

export async function answerOwner(text: string, messageRowId: number | null): Promise<OwnerAssistantOutput | null> {
  let out: OwnerAssistantOutput;
  try {
    const res = await generateStructured({
      purpose: "USER_QUERY",
      tier: "FAST",
      system: OWNER_ASSISTANT_SYSTEM,
      user: buildOwnerAssistantPrompt({ nowIso: nowLocal().toISO()!, message: text, context: await buildOwnerContext(text), recentDialog: await recentDialog() }),
      schema: OwnerAssistantSchema,
    });
    out = res.data;
  } catch (e) {
    log.error("owner assistant failed", { err: e });
    await notifyOwner("Hozir AI javob bera olmadi. Xabaringiz saqlandi — birozdan so'ng qayta urinib ko'ring. Buyruqlar (/tasks, /waiting, /brief) AI'siz ham ishlaydi.");
    return null;
  }
  const done = await applyOwnerActions(out, messageRowId);
  await notifyOwner([out.reply_text.trim(), ...done].filter(Boolean).join("\n\n"));
  return out;
}

async function ownerPersonId(): Promise<number | null> {
  const [o] = await db().select({ id: schema.persons.id }).from(schema.persons).where(eq(schema.persons.isOwner, true));
  return o?.id ?? null;
}

async function projectIdByName(name: string | null): Promise<number | null> {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  const all = await db().select().from(schema.projects);
  return all.find((p) => p.name.toLowerCase() === n || p.aliases.some((a) => a.toLowerCase() === n))?.id ?? null;
}

async function applyOwnerActions(out: OwnerAssistantOutput, messageRowId: number | null): Promise<string[]> {
  const notes: string[] = [];
  const d = db();
  const ownerId = await ownerPersonId();
  for (const a of out.actions) {
    try {
      switch (a.type) {
        case "CREATE_TASK":
        case "CREATE_REMINDER": {
          if (!a.title) break;
          const due = parseAiDate(a.due_iso);
          const forOwner = !a.owner_name || a.owner_name.toUpperCase() === "OWNER";
          const [row] = await d
            .insert(schema.tasks)
            .values({
              title: a.title,
              description: a.details,
              projectId: await projectIdByName(a.project_name),
              ownerPersonId: forOwner ? ownerId : null,
              ownerNameText: forOwner ? "Abdulloh" : a.owner_name,
              assignedByPersonId: ownerId,
              status: "TODO",
              deadline: a.type === "CREATE_TASK" ? due : null,
              remindAt: a.type === "CREATE_REMINDER" ? due : null,
              sourceMessageId: messageRowId,
              confidence: 1,
              evidenceMessageIds: messageRowId ? [messageRowId] : [],
            })
            .returning({ id: schema.tasks.id });
          notes.push(a.type === "CREATE_REMINDER" ? `⏰ Eslatma #${row.id} saqlandi${due ? `: ${fmtLocal(due)}` : ""}` : `✅ Vazifa #${row.id} qo'shildi`);
          break;
        }
        case "COMPLETE_TASK": {
          if (!a.task_id) break;
          const r = await d.update(schema.tasks).set({ status: "DONE", completedAt: new Date(), updatedAt: new Date() }).where(eq(schema.tasks.id, a.task_id)).returning({ id: schema.tasks.id });
          if (r.length) notes.push(`✔️ #${a.task_id} bajarildi deb belgilandi`);
          break;
        }
        case "SAVE_NOTE": {
          const t = a.details ?? a.title;
          if (!t) break;
          await d.insert(schema.ownerNotes).values({ text: t, projectId: await projectIdByName(a.project_name), sourceMessageId: messageRowId });
          notes.push("📝 Eslab qoldim");
          break;
        }
        case "CONFIRM_PREFERENCE":
          if (a.preference_id && (await setOwnerVerdict(a.preference_id, "CONFIRM"))) notes.push(`🧠 #${a.preference_id} tasdiqlandi`);
          break;
        case "REJECT_PREFERENCE":
          if (a.preference_id && (await setOwnerVerdict(a.preference_id, "REJECT"))) notes.push(`🧠 #${a.preference_id} rad etildi`);
          break;
        case "STATE_PREFERENCE": {
          const statement = a.details ?? a.title;
          if (!statement) break;
          const pid = await projectIdByName(a.project_name);
          await addEvidence({
            create: { scope: pid ? "PROJECT" : a.scope ?? "GLOBAL", projectId: pid, statement },
            polarity: "SUPPORTS",
            messageIds: messageRowId ? [messageRowId] : [],
            source: "OWNER_STATEMENT",
            confirm: true,
          });
          notes.push("🧠 Buni siz aytgan qoida sifatida saqladim");
          break;
        }
      }
    } catch (e) {
      log.warn("owner action failed", { type: a.type, err: e });
    }
  }
  return notes;
}

/** Due reminders → owner only. */
export async function sendDueReminders(now = new Date()): Promise<number> {
  const rows = await db()
    .select()
    .from(schema.tasks)
    .where(and(inArray(schema.tasks.status, OPEN_TASK), sql`${schema.tasks.remindAt} <= ${now}`, sql`${schema.tasks.remindedAt} is null`))
    .limit(20);
  for (const t of rows) {
    const claimed = await db().update(schema.tasks).set({ remindedAt: now }).where(and(eq(schema.tasks.id, t.id), sql`${schema.tasks.remindedAt} is null`)).returning();
    if (!claimed.length) continue;
    await notifyOwner(`⏰ Eslatma: ${t.title}${t.ownerNameText && t.ownerNameText !== "Abdulloh" ? ` (${t.ownerNameText})` : ""}${t.deadline ? `\nMuddat: ${fmtLocal(t.deadline)}` : ""}`);
  }
  return rows.length;
}
