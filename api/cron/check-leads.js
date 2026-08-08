// Har 2 soatda ishga tushadi (Vercel Pro cron yoki GitHub Actions orqali — README.md ga qarang).
// Vazifasi: yangi leadlarni Zebo'ga taqsimlash, muddati kelgan qayta aloqalarni
// Muslima'ga eslatish, muddati o'tganlarni Nozima'ga o'tkazish, va chala qolgan
// leadlar haqida guruhga savol yozish.

const { getAllLeads, batchUpdateLeads } = require("../../lib/sheets");
const { sendMessage, mention } = require("../../lib/telegram");
const { planActionsForLead } = require("../../lib/logic");
const { wasNotifiedToday, markNotifiedToday } = require("../../lib/store");
const { MANAGERS } = require("../../lib/config");

module.exports = async function handler(req, res) {
  // Himoya: faqat to'g'ri sirli kalit bilan chaqirilsa ishlaydi.
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const now = new Date();
  const leads = await getAllLeads();

  const sheetUpdates = [];
  const groupedByManager = { muslima: [], nozima: [] };

  for (const lead of leads) {
    const { updates, notifications } = await planActionsForLead(
      lead,
      now,
      wasNotifiedToday
    );

    if (Object.keys(updates).length) {
      sheetUpdates.push({
        rowNumber: lead.rowNumber,
        values: { ...updates, lastBotAction: now.toISOString() },
      });
    }

    for (const n of notifications) {
      groupedByManager[n.managerKey] = groupedByManager[n.managerKey] || [];
      groupedByManager[n.managerKey].push({ leadId: lead.id, rowNumber: lead.rowNumber, ...n });
    }
  }

  // Sheetni bitta so'rovda yangilaymiz.
  await batchUpdateLeads(sheetUpdates);

  // "ask_quality" turidagi savollar HAR BIRI alohida xabar bo'lib boradi —
  // chunki managerdan aynan shu xabarga Reply qilib javob kutiladi
  // (webhook shu javobni #L<qator> markeri orqali topadi).
  // Qolgan (taqsimlash/eslatma) xabarlar esa manager bo'yicha bitta xabarga
  // yig'ilib yuboriladi — guruhda ortiqcha spam bo'lmasligi uchun.
  let totalSent = 0;
  for (const key of Object.keys(groupedByManager)) {
    const items = groupedByManager[key];
    if (!items.length) continue;

    const questions = items.filter((it) => it.type === "ask_quality");
    const routine = items.filter((it) => it.type !== "ask_quality");

    if (routine.length) {
      const lines = routine.map((it) => `• ${it.text}`).join("\n");
      const text = `${mention(key)}, e'tibor bering (${routine.length} ta):\n\n${lines}`;
      await sendMessage(text);
      for (const it of routine) {
        await markNotifiedToday(it.leadId, it.type);
      }
      totalSent += routine.length;
    }

    for (const q of questions) {
      await sendMessage(`${mention(key)} ${q.text}`, { rowNumber: q.rowNumber });
      await markNotifiedToday(q.leadId, q.type);
      totalSent += 1;
    }
  }

  res.status(200).json({
    ok: true,
    checked: leads.length,
    updated: sheetUpdates.length,
    notificationsSent: totalSent,
  });
};
