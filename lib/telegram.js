// Telegram Bot API bilan ishlash: xabar yuborish va managerlarni ismi bilan chaqirish (mention).

const { MANAGERS } = require("./config");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Telegram foydalanuvchi ID orqali mention (username bo'lmasa ham ishlaydi).
 * HTML parse_mode talab qiladi.
 */
function mention(managerKey) {
  const m = MANAGERS[managerKey];
  if (!m) return managerKey;
  return `<a href="tg://user?id=${m.telegramId}">${escapeHtml(m.name)}</a>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Guruhga xabar yuboradi. replyMarkerId berilsa, xabar oxiriga yashirin
 * #L<rowNumber> markeri qo'shiladi — manager shu xabarga "Reply" qilganda
 * webhook qaysi lead haqida ekanini shundan biladi.
 */
async function sendMessage(text, { rowNumber } = {}) {
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  let fullText = text;
  if (rowNumber) {
    fullText += `\n<code>#L${rowNumber}</code>`;
  }

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: fullText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const json = await res.json();
  if (!json.ok) {
    console.error("Telegram sendMessage xatosi:", json);
  }
  return json;
}

async function setWebhook(url) {
  const body = { url };
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
  }
  const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

module.exports = {
  mention,
  sendMessage,
  setWebhook,
  escapeHtml,
};
