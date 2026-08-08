// Google Sheets bilan ishlash: o'qish va yozish.
// Xizmat hisobi (service account) orqali ulanadi — README.md da qanday sozlash yozilgan.

const { google } = require("googleapis");
const { COLS, DATA_RANGE, SHEET_NAME } = require("./config");

let cachedClient = null;

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Vercel env var'da ko'p qatorli private key \n bilan saqlanadi, shuni haqiqiy
  // yangi qatorga aylantiramiz.
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!email || !key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL yoki GOOGLE_PRIVATE_KEY environment variable topilmadi."
    );
  }

  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient() {
  if (cachedClient) return cachedClient;
  const auth = getAuth();
  await auth.authorize();
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

function colToIndex(col) {
  // "A" -> 0, "B" -> 1, ... "Z" -> 25
  return col.charCodeAt(0) - "A".charCodeAt(0);
}

/**
 * Barcha qatorlarni o'qib, har birini { rowNumber, raw:[...], ...maydonlar } shaklida qaytaradi.
 * Bo'sh (ismi va telefoni yo'q) qatorlarni tashlab ketadi.
 */
async function getAllLeads() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID environment variable topilmadi.");
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: DATA_RANGE,
  });

  const rows = res.data.values || [];
  const leads = [];

  rows.forEach((raw, i) => {
    const rowNumber = i + 1; // sheetda 1-qatordan boshlanadi (header yo'q)
    const get = (colLetter) => raw[colToIndex(colLetter)] || "";

    const name = get(COLS.name);
    const phone = get(COLS.phone) || get(COLS.additionalPhone);
    if (!name && !phone) return; // bo'sh qator

    leads.push({
      rowNumber,
      id: get(COLS.id),
      createdTime: get(COLS.createdTime),
      adName: get(COLS.adName),
      city: get(COLS.city),
      area: get(COLS.area),
      name,
      phone,
      status: get(COLS.status),
      quality: get(COLS.quality),
      comment: get(COLS.comment),
      note2: get(COLS.note2),
      manager: get(COLS.manager),
      stage: get(COLS.stage),
      nextFollowup: get(COLS.nextFollowup),
      lastBotAction: get(COLS.lastBotAction),
      lastAskedAt: get(COLS.lastAskedAt),
    });
  });

  return leads;
}

/**
 * Bir nechta qatorlarni bitta batchUpdate chaqiruvi bilan yangilaydi.
 * updates: [{ rowNumber, values: { manager, stage, nextFollowup, lastBotAction, lastAskedAt, comment, ... } }]
 */
async function batchUpdateLeads(updates) {
  if (!updates.length) return;
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const data = [];
  for (const { rowNumber, values } of updates) {
    for (const [field, value] of Object.entries(values)) {
      const colLetter = COLS[field];
      if (!colLetter) continue;
      data.push({
        range: `${SHEET_NAME}!${colLetter}${rowNumber}`,
        values: [[value]],
      });
    }
  }

  if (!data.length) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });
}

module.exports = {
  getAllLeads,
  batchUpdateLeads,
};
