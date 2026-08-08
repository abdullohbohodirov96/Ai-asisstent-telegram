// Har kuni soat 20:00 (Toshkent, = 15:00 UTC) da Vercel Cron orqali ishga tushadi.
// Kunlik hisobotni tayyorlab, Telegram guruhga yozadi: nechta lead tushdi,
// nechtasi bilan gaplashildi, sifatli/sifatsiz nisbati, manager kesimida
// taqsimot, va hali chala qolgan leadlar ro'yxati (ismi bilan chaqirilgan holda).

const { getAllLeads } = require("../../lib/sheets");
const { sendMessage, mention, escapeHtml } = require("../../lib/telegram");
const { computeDailyStats, fmtDate, fmtDateTime, managerKeyByName } = require("../../lib/logic");
const { MANAGERS } = require("../../lib/config");

module.exports = async function handler(req, res) {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const now = new Date();
  const leads = await getAllLeads();
  const stats = computeDailyStats(leads, now);

  const lines = [];
  lines.push(`📊 <b>Kunlik hisobot — ${fmtDate(now)}</b>`);
  lines.push("");
  lines.push(`Bugun tushgan leadlar: <b>${stats.totalToday}</b>`);
  lines.push(`Gaplashilgan: <b>${stats.contactedToday}</b> / ${stats.totalToday}`);
  lines.push(
    `Sifatli: <b>${stats.qualityToday}</b> · Sifatsiz: <b>${stats.nonQualityToday}</b> · Sifat darajasi: <b>${stats.qualityPct}%</b>`
  );
  lines.push("");
  lines.push("👥 <b>Manager kesimida:</b>");
  for (const key of Object.keys(MANAGERS)) {
    const m = MANAGERS[key];
    const s = stats.byManager[key];
    lines.push(
      `${mention(key)} (${escapeHtml(m.role)}): ${s.total} ta lead, gaplashilgan ${s.contacted}, sifatli ${s.quality}, sifatsiz ${s.nonQuality}`
    );
  }

  if (stats.pending.length) {
    lines.push("");
    lines.push(`⚠️ <b>Hali chala/javobsiz qolgan leadlar (${stats.pending.length} ta):</b>`);
    const shown = stats.pending.slice(0, 20);
    for (const l of shown) {
      const mgrKey = managerKeyByName(l.manager);
      const who = mgrKey ? mention(mgrKey) : "manager belgilanmagan";
      lines.push(`• ${escapeHtml(l.name)} (${escapeHtml(l.phone)}) — ${who}`);
    }
    if (stats.pending.length > shown.length) {
      lines.push(`... va yana ${stats.pending.length - shown.length} ta`);
    }
  }

  lines.push("");
  let verdict;
  if (stats.totalToday === 0) {
    verdict = "Bugun yangi lead tushmadi.";
  } else if (stats.qualityPct >= 60) {
    verdict = "✅ Umumiy sifat darajasi yaxshi.";
  } else if (stats.qualityPct >= 35) {
    verdict = "🟡 Umumiy sifat darajasi o'rtacha — reklama manbalarini tekshirib ko'ring.";
  } else {
    verdict = "🔴 Umumiy sifat darajasi past — reklama sozlamalarini qayta ko'rib chiqish tavsiya etiladi.";
  }
  lines.push(`<b>Xulosa:</b> ${verdict}`);
  lines.push("");
  lines.push(`<i>Yangilangan: ${fmtDateTime(now)}</i>`);

  await sendMessage(lines.join("\n"));

  res.status(200).json({ ok: true, stats });
};
