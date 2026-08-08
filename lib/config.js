// Umumiy sozlamalar: managerlar, ustun harflari, vaqt zonasi va biznes qoidalari.

const TIMEZONE = "Asia/Tashkent"; // UTC+5

// Sheetdagi ustunlar (harf bo'yicha). Sheetda sarlavha qatori yo'q — 1-qatordan
// ma'lumot boshlanadi. FB/IG lead-sync avtomatik to'ldiradigan ustunlar A-U,
// V dan keyingisini shu bot o'zi boshqaradi.
const COLS = {
  id: "A",
  createdTime: "B",
  adId: "C",
  adName: "D",
  adsetId: "E",
  adsetName: "F",
  campaignId: "G",
  campaignName: "H",
  formId: "I",
  formName: "J",
  isOrganic: "K",
  platform: "L",
  city: "M",
  area: "N",
  name: "O",
  additionalPhone: "P",
  phone: "Q",
  status: "R", // Haa / Yo'q / tel omadi / noto'g'ri raqam
  quality: "S", // Sifatli / Sifatsiz
  comment: "T", // manager izohi
  note2: "U", // qo'shimcha izoh (masalan "qayta aloqa" eslatmasi)
  // --- bot o'zi yozadigan/yangilaydigan ustunlar ---
  manager: "V", // Zebo / Muslima / Nozima
  stage: "W", // 1-yangi / 2-qayta_aloqa / 3-eski
  nextFollowup: "X", // YYYY-MM-DD — Muslima qachon qayta aloqa qilishi kerak
  lastBotAction: "Y", // bot oxirgi marta shu qatorni qachon o'zgartirgani (ISO sana)
  lastAskedAt: "Z", // bot oxirgi marta savol berganini ISO sana
};

const FIRST_COL = "A";
const LAST_COL = "Z";
const SHEET_NAME = process.env.SHEET_NAME || "Лист1";
const DATA_RANGE = `${SHEET_NAME}!${FIRST_COL}1:${LAST_COL}5000`;

const MANAGERS = {
  muslima: {
    key: "muslima",
    name: "Muslima",
    telegramId: 8167445322,
    role: "Qayta aloqa (2-3 chi kontakt)",
  },
  nozima: {
    key: "nozima",
    name: "Nozima",
    telegramId: 8507670071,
    role: "Yangi leadlar bilan birinchi aloqa + eski/sovuq mijozlar",
  },
};

const STAGES = {
  NEW: "1-yangi",
  FOLLOWUP: "2-qayta_aloqa",
  OLD: "3-eski",
};

// Biznes qoidalar (foydalanuvchi bilan kelishilgan):
const RULES = {
  // Yangi lead kelgach, shuncha soatdan keyin hali gaplashilmagan bo'lsa Zebo'ga eslatma.
  newLeadReminderHours: 2,
  // 3 kundan keyin, agar yakunlanmagan bo'lsa (sotilmagan/yopilmagan), avtomatik Nozima'ga o'tadi.
  oldLeadAfterDays: 3,
  // Qayta aloqa sanasi o'tib ketsa-yu hali bog'lanilmagan bo'lsa, ertasi kuni Nozima'ga o'tadi.
  followupGraceDays: 1,
  // Har necha soatda tekshiruv ishga tushadi (faqat hujjat/eslatma uchun, cron tashqi trigger orqali).
  checkIntervalHours: 2,
};

// Yakunlangan/yopilgan deb hisoblanadigan izoh kalit so'zlari (regex, case-insensitive)
const CLOSED_KEYWORDS = /sot(il|ild)|yopildi|bekor qilindi|kerak emas|rad etdi/i;

module.exports = {
  TIMEZONE,
  COLS,
  DATA_RANGE,
  SHEET_NAME,
  MANAGERS,
  STAGES,
  RULES,
  CLOSED_KEYWORDS,
};
