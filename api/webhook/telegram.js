// Telegram webhook: managerlar guruhda botning savol/eslatma xabariga
// "Reply" qilib javob yozganda shu yerga keladi. Javobni sheetga yozib qo'yadi.
//
// Ishlash tartibi manager uchun: bot yozgan xabarga albatta Telegram'ning
// "Reply" (javob berish) funksiyasi bilan javob yozish kerak — shunda bot
// qaysi lead haqida gap ketayotganini biladi (xabar oxiridagi #L<raqam> orqali).

const { batchUpdateLeads } = require("../../lib/sheets");
const { sendMessage } = require("../../lib/telegram");
const { fmtDateTime } = require("../../lib/logic");

module.exports = async function handler(req, res) {
  // Telegram setWebhook chaqirilganda secret_token berilgan bo'lsa, shu header keladi.
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secretHeader !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(401).json({ ok: false });
    return;
  }

  const update = req.body;
  const message = update && update.message;

  if (!message || !message.text) {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const replyTo = message.reply_to_message;
  const markerSource = (replyTo && replyTo.text) || "";
  const match = markerSource.match(/#L(\d+)/);

  if (!match) {
    // Bot xabariga reply qilinmagan — hech narsa qilinmaydi (guruhdagi oddiy suhbat).
    res.status(200).json({ ok: true, skipped: true, reason: "no-marker" });
    return;
  }

  const rowNumber = parseInt(match[1], 10);
  const managerName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  const replyText = message.text.trim();

  const now = new Date();
  const noteToAppend = `[${fmtDateTime(now)} ${managerName}]: ${replyText}`;

  const updates = {
    comment: noteToAppend,
    lastBotAction: now.toISOString(),
  };

  // Oddiy kalit so'zlar bo'yicha status/sifatni ham avtomatik yangilashga urinamiz
  // (manager xohlasa qo'lda sheetda ham tuzatishi mumkin).
  if (/sifatli/i.test(replyText) && !/sifatsiz/i.test(replyText)) {
    updates.quality = "Sifatli";
  } else if (/sifatsiz/i.test(replyText)) {
    updates.quality = "Sifatsiz";
  }
  if (/gaplash|bog'land|tel qi|qo'ng'iroq/i.test(replyText)) {
    updates.status = "Haa";
  }

  await batchUpdateLeads([{ rowNumber, values: updates }]);

  await sendMessage(`✅ Qabul qilindi, ${managerName} javobi sheetga yozildi (qator ${rowNumber}).`);

  res.status(200).json({ ok: true, rowNumber, updates });
};
