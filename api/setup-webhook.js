// Bir martalik yordamchi endpoint: Telegram webhookni sizning Vercel domeningizga
// ulab qo'yadi. Deploy qilgach, brauzerda bir marta oching:
//   https://SIZNING-DOMEN.vercel.app/api/setup-webhook?secret=CRON_SECRET
// Muvaffaqiyatli bo'lsa, shundan keyin bu faylni o'chirib qo'yishingiz ham mumkin.

const { setWebhook } = require("../lib/telegram");

module.exports = async function handler(req, res) {
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = `https://${host}/api/webhook/telegram`;

  const result = await setWebhook(url);
  res.status(200).json({ ok: true, webhookUrl: url, telegramResponse: result });
};
