import { and, desc, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { config } from "../config/env.js";
import { db, schema } from "../db/client.js";
import { generateText } from "../ai/client.js";
import { todayUsage, monthUsage, isBackgroundPaused } from "../ai/usage.js";
import { effectiveFlags, SHADOW_MODE_V1_LOCK } from "../telegram/shadowGuard.js";
import { gatherReportData, OPEN_TASK } from "../reports/data.js";
import { generateAndSendReport } from "../reports/service.js";
import { confidenceLabel } from "../engine/preferences.js";
import { askNextQuestion } from "../engine/questions.js";
import { fmtLocal, nowLocal, startOfLocalDay } from "../util/time.js";
import { notifyOwner } from "./notify.js";

type Handler = (args: string) => Promise<string | null>;

const pmap = async () => new Map((await db().select().from(schema.persons)).map((p) => [p.id, p]));
const prjmap = async () => new Map((await db().select().from(schema.projects)).map((p) => [p.id, p.name]));

async function taskLines(filter?: (t: typeof schema.tasks.$inferSelect) => boolean, limit = 40): Promise<string[]> {
  const people = await pmap();
  const projects = await prjmap();
  const now = new Date();
  const rows = (await db().select().from(schema.tasks).where(inArray(schema.tasks.status, OPEN_TASK)).orderBy(schema.tasks.deadline)).filter(filter ?? (() => true)).slice(0, limit);
  const groups = new Map<string, string[]>();
  for (const t of rows) {
    const key = t.projectId ? projects.get(t.projectId)! : "❔ Loyiha noma'lum";
    const owner = t.ownerNameText ?? (t.ownerPersonId ? people.get(t.ownerPersonId)?.name : null) ?? "?";
    const dl = t.deadline ? ` · ${fmtLocal(t.deadline)}${t.deadline < now ? " ⛔️O'TGAN" : ""}` : "";
    const conf = t.confidence < 0.5 ? " (taxmin)" : "";
    groups.set(key, [...(groups.get(key) ?? []), `  • #${t.id} ${t.title} — ${owner}${dl} [${t.status}]${conf}`]);
  }
  const out: string[] = [];
  for (const [k, v] of groups) out.push(`📁 ${k}`, ...v);
  return out;
}

const commands: Record<string, Handler> = {
  async start() {
    return `Salom, Abdulloh! Men sizning AI Chief of Staff'ingizman (Shadow Mode V1).\nMen faqat o'qiyman, tahlil qilaman, o'rganaman va FAQAT sizga yozaman.\n\nBuyruqlar: /brief /today /tasks /waiting /projects /people /learn /questions /report /cost /shadow`;
  },

  async help() {
    return commands.start("");
  },

  async brief() {
    const data = await gatherReportData("MANUAL");
    try {
      const { text } = await generateText({
        purpose: "USER_QUERY",
        tier: "FAST",
        system:
          "You are Abdulloh's AI Chief of Staff. Write a SHORT current-state brief in Uzbek Latin, plain text, max 12 lines: 3-5 key facts, then 'Hozir qilish kerak:' with up to 3 bullets. Use only DATA.",
        user: `DATA:\n${JSON.stringify(data)}`,
      });
      return `🧭 BRIEF\n\n${text.trim()}`;
    } catch {
      const s = data.stats;
      return `🧭 BRIEF\n• Ochiq vazifalar: ${s.open_tasks} (muddati o'tgan: ${s.overdue})\n• Bugun tahlil: ${s.analysed_conversations} suhbat\n• Javobsiz muhim: ${data.unanswered_important.length}\n• Kutilayotgan: ${data.waiting_for.length}`;
    }
  },

  async today() {
    const now = new Date();
    const endOfDay = nowLocal(now).endOf("day").toJSDate();
    const lines = await taskLines((t) => Boolean(t.deadline && t.deadline <= endOfDay));
    const fu = await db()
      .select()
      .from(schema.meetingsFollowUps)
      .where(and(eq(schema.meetingsFollowUps.status, "OPEN"), gte(schema.meetingsFollowUps.scheduledAt, startOfLocalDay(now)), lte(schema.meetingsFollowUps.scheduledAt, endOfDay)));
    const out = [`📅 BUGUN (${fmtLocal(now, "dd.LL.yyyy")})`];
    out.push(lines.length ? lines.join("\n") : "Bugunga muddatli vazifa yo'q.");
    if (fu.length) out.push("\n📅 Uchrashuv/follow-up:", ...fu.map((f) => `  • ${fmtLocal(f.scheduledAt, "HH:mm")} ${f.title}`));
    return out.join("\n");
  },

  async tasks() {
    const lines = await taskLines();
    return lines.length ? `✅ AKTIV VAZIFALAR\n${lines.join("\n")}` : "Aktiv vazifa yo'q.";
  },

  async waiting() {
    const people = await pmap();
    const rows = await db().select().from(schema.waitingItems).where(eq(schema.waitingItems.status, "OPEN")).orderBy(schema.waitingItems.dueAt).limit(40);
    if (!rows.length) return "⏳ Hozir hech narsa kutilmayapti.";
    const who = (r: (typeof rows)[number]) => r.personText ?? (r.personId ? people.get(r.personId)?.name : "?") ?? "?";
    const mine = rows.filter((r) => r.direction === "OWNER_WAITS").map((r) => `  • ${who(r)}: ${r.what}${r.dueAt ? ` (${fmtLocal(r.dueAt)})` : ""}`);
    const theirs = rows.filter((r) => r.direction === "WAITS_FOR_OWNER").map((r) => `  • ${who(r)}: ${r.what}${r.dueAt ? ` (${fmtLocal(r.dueAt)})` : ""}`);
    return ["⏳ WAITING FOR", mine.length ? "Siz kutyapsiz:" : "", ...mine, theirs.length ? "Sizdan kutishyapti:" : "", ...theirs].filter(Boolean).join("\n");
  },

  async projects() {
    const rows = await db().select().from(schema.projects).where(notInArray(schema.projects.status, ["ARCHIVED"]));
    if (!rows.length) return "📁 Hali loyiha yo'q. Men suhbatlardan aniqlab, sizdan tasdiq so'rayman.";
    const counts = await db()
      .select({ projectId: schema.tasks.projectId, n: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(inArray(schema.tasks.status, OPEN_TASK))
      .groupBy(schema.tasks.projectId);
    const c = new Map(counts.map((r) => [r.projectId, r.n]));
    return ["📁 LOYIHALAR", ...rows.map((p) => `• ${p.name} [${p.status}] — ${c.get(p.id) ?? 0} ochiq vazifa${p.aliases.length ? ` (aliases: ${p.aliases.join(", ")})` : ""}${p.summary ? `\n   ${p.summary.slice(0, 200)}` : ""}`)].join("\n");
  },

  async people() {
    const rows = await db().select().from(schema.persons).where(eq(schema.persons.isOwner, false)).orderBy(desc(schema.persons.updatedAt)).limit(30);
    if (!rows.length) return "👥 Hali odamlar yo'q.";
    const counts = await db()
      .select({ id: schema.tasks.ownerPersonId, n: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(inArray(schema.tasks.status, OPEN_TASK))
      .groupBy(schema.tasks.ownerPersonId);
    const c = new Map(counts.map((r) => [r.id, r.n]));
    return [
      "👥 ODAMLAR",
      ...rows.map((p) => {
        const role = p.role ? `${p.role}${p.roleConfirmed ? " ✓" : ` (taxmin, ${confidenceLabel(p.roleConfidence)})`}` : "rol noma'lum";
        return `• ${p.name}${p.username ? ` @${p.username}` : ""} — ${role} · ${c.get(p.id) ?? 0} ochiq vazifa`;
      }),
    ].join("\n");
  },

  async learn() {
    const [profile] = await db().select().from(schema.userProfile).where(eq(schema.userProfile.telegramUserId, config().telegram.ownerId));
    const prefs = await db().select().from(schema.preferences).where(notInArray(schema.preferences.status, ["REJECTED"])).orderBy(desc(schema.preferences.confidence)).limit(25);
    const projects = await prjmap();
    const out = ["🧠 MEN SIZ HAQINGIZDA BILGANLARIM"];
    if (profile) {
      const dims: [string, string | null][] = [
        ["Muloqot", profile.communicationStyle],
        ["Boshqaruv", profile.managementStyle],
        ["Delegatsiya", profile.delegationStyle],
        ["Qaror qabul qilish", profile.decisionStyle],
        ["Kreativ did", profile.creativeTaste],
        ["Ssenariy", profile.scenarioTaste],
        ["Dizayn", profile.designTaste],
        ["Video", profile.videoTaste],
      ];
      for (const [k, v] of dims) if (v) out.push(`\n${k}: ${v}`);
      for (const [pid, taste] of Object.entries((profile.projectTastes as Record<string, string>) ?? {})) out.push(`\n${projects.get(Number(pid)) ?? pid} didi: ${taste}`);
    }
    if (prefs.length) {
      out.push("\nPreference'lar:");
      for (const p of prefs) {
        const scope = p.projectId ? projects.get(p.projectId) : p.scope;
        out.push(`• #${p.id} [${scope}] ${p.statement} — ${p.status}, ${confidenceLabel(p.confidence)} (${p.confidence.toFixed(2)}), dalil: ${p.evidenceCount}${p.confirmedByOwner ? ", ✓ siz tasdiqlagansiz" : ""}`);
      }
      out.push("\n\"Nega #ID deb o'ylayapsan?\" deb so'rasangiz, dalillarini ko'rsataman.");
    } else out.push("Hali yetarli ma'lumot yo'q — suhbatlar tahlil qilingan sari o'rganaman.");
    return out.join("\n");
  },

  async questions(args) {
    const rows = await db()
      .select()
      .from(schema.learningQuestions)
      .where(inArray(schema.learningQuestions.status, ["OPEN", "ASKED", "PARTIALLY_RESOLVED"]))
      .orderBy(desc(schema.learningQuestions.importance))
      .limit(15);
    if (!rows.length) return "❓ Ochiq savol yo'q.";
    const list = ["❓ OCHIQ SAVOLLAR", ...rows.map((q) => `• [${q.status}] ${q.question}`)].join("\n");
    if (args.trim() === "next") {
      await notifyOwner(list);
      await askNextQuestion(new Date(), { ignoreHours: true });
      return null;
    }
    return `${list}\n\nKeyingisini hozir so'rashim uchun: /questions next`;
  },

  async report() {
    await notifyOwner("📋 To'liq hisobot tayyorlanmoqda…");
    await generateAndSendReport("MANUAL");
    return null;
  },

  async cost() {
    const t = await todayUsage();
    const m = await monthUsage();
    const budget = config().budget.monthlyUsd;
    const pct = budget > 0 ? ((m.costUsd / budget) * 100).toFixed(1) : "—";
    const byP = Object.entries(m.byPurpose)
      .map(([k, v]) => `  • ${k}: ${v.calls} ta, $${v.costUsd.toFixed(4)}`)
      .join("\n");
    return [
      "💸 AI XARAJAT (taxminiy)",
      `Bugun: ${t.calls} so'rov, ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out token, $${t.costUsd.toFixed(4)}`,
      `Shu oy: ${m.calls} so'rov, ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out token, $${m.costUsd.toFixed(4)} / $${budget} (${pct}%)`,
      byP ? `Maqsad bo'yicha (oy):\n${byP}` : "",
      `Modellar: fast=${config().gemini.modelFast}, deep=${config().gemini.modelDeep}`,
      (await isBackgroundPaused()) ? "⚠️ Byudjet tugagan: fon tahlili pauzada." : "",
    ]
      .filter(Boolean)
      .join("\n");
  },

  async shadow() {
    const f = effectiveFlags();
    const [blocked] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.outboundAudit).where(eq(schema.outboundAudit.allowed, false));
    const [sent] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.outboundAudit).where(eq(schema.outboundAudit.allowed, true));
    const conns = await db().select().from(schema.businessConnections);
    return [
      "🕶 SHADOW MODE V1: YOQILGAN (kod darajasida qulflangan)",
      `V1 lock: ${SHADOW_MODE_V1_LOCK ? "ON" : "OFF"}`,
      `ALLOW_AUTOREPLY: env=${f.requested.allowAutoreply} → amalda ${f.effective.allowAutoreply}`,
      `ALLOW_DELEGATION: env=${f.requested.allowDelegation} → amalda ${f.effective.allowDelegation}`,
      `ALLOW_PUBLISH: env=${f.requested.allowPublish} → amalda ${f.effective.allowPublish}`,
      `Faqat shu chatga yozaman: OWNER_TELEGRAM_ID=${config().telegram.ownerId}`,
      `Yuborilgan xabarlar (faqat sizga): ${sent.n} · Bloklangan urinishlar: ${blocked.n}`,
      `Business ulanishlar: ${conns.length ? conns.map((c) => `${c.isEnabled ? "faol" : "o'chiq"}${c.canReply ? " (⚠️ Telegram'da reply huquqi yoqilgan — baribir bloklanadi, lekin o'chirib qo'yish tavsiya etiladi)" : ""}`).join(", ") : "hali yo'q"}`,
    ].join("\n");
  },

  // ---- debug (owner only, like everything else)
  async debug_last_batch() {
    const [b] = await db().select().from(schema.messageBatches).orderBy(desc(schema.messageBatches.id)).limit(1);
    if (!b) return "Batch yo'q.";
    const [r] = await db().select().from(schema.analysisResults).where(eq(schema.analysisResults.batchId, b.id));
    const [n] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.messages).where(eq(schema.messages.batchId, b.id));
    const o = r?.output as any;
    return [
      `🔧 Batch #${b.id} chat=${b.chatId} ${fmtLocal(b.windowStart)}–${fmtLocal(b.windowEnd, "HH:mm")} seq=${b.seq}`,
      `status=${b.status} attempts=${b.attempts} msgs=${n.n} project=${b.projectId ?? "-"}${b.error ? ` error=${b.error}` : ""}`,
      r
        ? `model=${r.model} importance=${r.importance}\nsummary: ${r.summary}\ntasks=${o?.tasks?.length ?? 0} commitments=${o?.commitments?.length ?? 0} waiting=${o?.waiting_items?.length ?? 0} feedback=${o?.owner_feedback?.length ?? 0} prefs=${o?.preference_evidence?.length ?? 0} questions=${o?.clarification_questions?.length ?? 0}`
        : "analysis yo'q",
    ].join("\n");
  },

  async debug_memory() {
    const [counts] = (
      await db().execute(sql`select
        (select count(*) from as_messages)::int as messages,
        (select count(*) from as_messages where analysis_status='PENDING')::int as pending,
        (select count(*) from as_messages where analysis_status='FAILED')::int as failed,
        (select count(*) from as_message_batches where status in ('PENDING','FAILED'))::int as batches_pending,
        (select count(*) from as_tasks)::int as tasks,
        (select count(*) from as_preferences)::int as prefs,
        (select count(*) from as_learning_evidence where active)::int as evidence,
        (select count(*) from as_learning_questions where status in ('OPEN','ASKED'))::int as questions,
        (select count(*) from as_persons)::int as persons,
        (select count(*) from as_projects)::int as projects`)
    ).rows as any[];
    return `🔧 MEMORY\n${Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}`;
  },

  async debug_project(args) {
    const name = args.trim().toLowerCase();
    const all = await db().select().from(schema.projects);
    const p = all.find((x) => x.name.toLowerCase() === name || x.aliases.some((a) => a.toLowerCase() === name)) ?? (all.length === 1 ? all[0] : null);
    if (!p) return `Loyiha topilmadi. Mavjud: ${all.map((x) => x.name).join(", ") || "-"}\nFoydalanish: /debug_project <nom>`;
    const members = await db().select().from(schema.projectMembers).where(eq(schema.projectMembers.projectId, p.id));
    const prefs = await db().select().from(schema.preferences).where(eq(schema.preferences.projectId, p.id));
    return `🔧 ${p.name} (#${p.id}) ${p.status}\naliases: ${p.aliases.join(", ") || "-"}\nsummary: ${p.summary ?? "-"}\nmembers: ${members.length}\nproject preferences: ${prefs.length}`;
  },

  async debug_usage() {
    const rows = await db().select().from(schema.aiUsage).orderBy(desc(schema.aiUsage.id)).limit(10);
    return ["🔧 Oxirgi 10 AI chaqiruv", ...rows.map((r) => `${fmtLocal(r.createdAt, "dd.LL HH:mm")} ${r.purpose} ${r.model} in=${r.inputTokens} out=${r.outputTokens} $${Number(r.estimatedCostUsd).toFixed(5)}${r.success ? "" : " ✗"}`)].join("\n");
  },
};

export const COMMAND_LIST = Object.keys(commands);

/** Returns true if the text was a known command (already answered). */
export async function handleCommand(text: string): Promise<boolean> {
  const m = text.trim().match(/^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const h = commands[name];
  if (!h) {
    await notifyOwner(`Noma'lum buyruq: /${name}\n/help — buyruqlar ro'yxati`);
    return true;
  }
  const reply = await h(m[2] ?? "");
  if (reply) await notifyOwner(reply);
  return true;
}
