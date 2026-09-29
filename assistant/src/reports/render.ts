import type { ReportData } from "./data.js";

const TITLES: Record<string, string> = {
  MORNING: "🌅 ERTALABKI BRIEF",
  MIDDAY: "🕐 KUNDUZGI BRIEF",
  EVENING: "🌆 KECHKI TO'LIQ REVIEW",
  MANUAL: "📋 TO'LIQ HISOBOT",
};

export function reportTitle(slot: string, period: { since: string; until: string }): string {
  return `${TITLES[slot] ?? TITLES.MANUAL} · ${period.since} → ${period.until}`;
}

/** Deterministic fallback used when AI is unavailable. Always correct, less eloquent. */
export function renderFallbackReport(d: ReportData): string {
  const L: string[] = [];
  const sec = (h: string, items: string[]) => {
    if (!items.length) return;
    L.push("", h, ...items.map((i) => `• ${i}`));
  };
  L.push("🧠 QISQA HOLAT");
  L.push(
    `• ${d.stats.analysed_conversations} ta suhbat tahlil qilindi, ${d.stats.tasks_created} ta yangi vazifa, ${d.stats.tasks_done} ta bajarildi.`,
    `• Ochiq vazifalar: ${d.stats.open_tasks}, muddati o'tgan: ${d.stats.overdue}.`,
  );
  for (const a of d.activity.slice(0, 3)) if (a.summary) L.push(`• ${a.chat}: ${a.summary}`);
  sec("🔴 MEN HOZIR QILISHIM KERAK", [
    ...d.owner_tasks.slice(0, 6).map((t) => `${t.title}${t.deadline ? ` (muddat ${t.deadline}${t.overdue ? ", O'TGAN" : ""})` : ""}`),
    ...d.waiting_for.filter((w) => w.direction.includes("kutilyapti")).slice(0, 4).map((w) => `${w.person ?? "?"} sizdan kutyapti: ${w.what}`),
    ...d.unanswered_important.slice(0, 4).map((u) => `${u.from} javob kutyapti (${u.at}): ${u.text}`),
  ]);
  sec(
    "📁 PROJECTLAR",
    d.projects.filter((p) => p.open_tasks || p.summary).map((p) => `${p.name}: ${p.open_tasks} ochiq vazifa${p.overdue ? `, ${p.overdue} ta muddati o'tgan` : ""}${p.summary ? ` — ${p.summary.slice(0, 140)}` : ""}`),
  );
  sec("👥 ODAMLAR", d.delegated_tasks.slice(0, 10).map((t) => `${t.owner ?? "?"}: ${t.title}${t.deadline ? ` (${t.deadline}${t.overdue ? ", O'TGAN" : ""})` : ""}`));
  sec("⏳ WAITING FOR", d.waiting_for.slice(0, 10).map((w) => `${w.direction}: ${w.person ?? "?"} — ${w.what}${w.due ? ` (${w.due})` : ""}`));
  sec("💬 JAVOBSIZ MUHIM XABARLAR", d.unanswered_important.slice(0, 8).map((u) => `${u.from} (${u.chat}, ${u.at}): ${u.text}`));
  sec("🤝 VA'DALAR / COMMITMENTS", d.commitments.slice(0, 10).map((c) => `${c.who ?? "?"} → ${c.to ?? "?"}: ${c.what}${c.due ? ` (${c.due}${c.overdue ? ", O'TGAN" : ""})` : ""}`));
  sec("📅 UCHRASHUV / FOLLOW-UP", d.followups.slice(0, 8).map((f) => `${f.title} — ${f.when}${f.with ? `, ${f.with}` : ""}`));
  sec("🎬 CREATIVE / DESIGN / SCENARIO", [
    ...d.creative.submitted.map((s) => `${s.by ?? "?"} ${s.kind} yubordi${s.project ? ` (${s.project})` : ""}: ${s.status}`),
    ...d.creative.owner_feedback.map((f) => `Siz: ${f.reaction} — ${f.reason ?? (f.hypothesis ? `(taxmin) ${f.hypothesis}` : "sabab aytilmagan")}`),
  ]);
  sec("🧠 MEN HAQIMDA YANGI O'RGANGANLARING", d.learnings.slice(0, 6).map((l) => `${l.observation} · dalil: ${l.evidence_count} · ${l.confidence} · ${l.scope}${l.confirmed_by_owner ? " · tasdiqlangan" : ""}`));
  sec("❓ MENING JAVOBIM KERAK", d.open_questions.map((q) => q.question));
  sec("⚠️ RISK / UNUTILIB QOLISHI MUMKIN", d.risks.slice(0, 6).map((r) => `[${r.severity}] ${r.description} (${r.chat})`));
  const next = [
    ...d.owner_tasks.filter((t) => t.overdue).map((t) => `Muddati o'tgan: ${t.title}`),
    ...d.unanswered_important.map((u) => `${u.from}ga javob bering`),
    ...d.suggested_next_actions,
    ...d.owner_tasks.map((t) => t.title),
  ].slice(0, 3);
  L.push("", "➡️ KEYINGI ENG TO'G'RI 3 ACTION");
  if (!next.length) L.push("1. Hozircha shoshilinch action yo'q.");
  next.forEach((n, i) => L.push(`${i + 1}. ${n}`));
  L.push("", "(AI mavjud emasligi sababli avtomatik shablon bilan tuzildi)");
  return L.join("\n");
}
