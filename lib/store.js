// Kichik holat (state) saqlash — Vercel KV (Upstash Redis) orqali.
// Vazifasi: bir xil lead uchun eslatma/savolni kuniga bir marta yuborish,
// har 2 soatlik tekshiruvda qayta-qayta spam qilmaslik.
//
// Agar Vercel KV ulanmagan bo'lsa (development/test), xotirada (in-memory)
// ishlaydigan zaxira variant ishlatiladi — lekin bu har deploy/restartda tozalanadi,
// shuning uchun productionda KV ulash SHART (README.md ga qarang).

let kv = null;
try {
  // @vercel/kv o'rnatilgan va env sozlangan bo'lsa shu ishlatiladi.
  kv = require("@vercel/kv").kv;
} catch (e) {
  kv = null;
}

const memoryStore = new Map();

function todayKey() {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC, taxminiy kifoya)
}

/**
 * leadId + type (masalan "new_reminder", "ask_status", "escalate_nozima")
 * bo'yicha, bugun allaqachon xabar yuborilganmi shuni tekshiradi.
 */
async function wasNotifiedToday(leadId, type) {
  const key = `notified:${todayKey()}:${type}:${leadId}`;
  if (kv) {
    const val = await kv.get(key);
    return Boolean(val);
  }
  return memoryStore.has(key);
}

async function markNotifiedToday(leadId, type) {
  const key = `notified:${todayKey()}:${type}:${leadId}`;
  if (kv) {
    // 3 kun saqlanadi (kuniga bitta xabar tekshiruvi uchun yetarli), keyin o'zi o'chadi.
    await kv.set(key, "1", { ex: 60 * 60 * 24 * 3 });
    return;
  }
  memoryStore.set(key, "1");
}

module.exports = {
  wasNotifiedToday,
  markNotifiedToday,
};
