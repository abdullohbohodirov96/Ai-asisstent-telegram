// Biznes logika: har bir lead qaysi bosqichda, qaysi managerga tegishli,
// va bot unga eslatma/savol yozishi kerakmi — shularni hisoblaydi.
//
// MUHIM: bu fayl sheets/telegramga bevosita murojaat qilmaydi (pure logic),
// shuning uchun test qilish va o'zgartirish oson.

const { MANAGERS, STAGES, RULES, CLOSED_KEYWORDS, TIMEZONE } = require("./config");

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

function hoursBetween(a, b) {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

function fmtDate(d) {
  return new Intl.DateTimeFormat("uz-UZ", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function fmtDateTime(d) {
  return new Intl.DateTimeFormat("uz-UZ", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function isSameLocalDay(d1, d2) {
  return fmtDate(d1) === fmtDate(d2);
}

function isClosed(lead) {
  const text = `${lead.comment || ""} ${lead.note2 || ""}`;
  return CLOSED_KEYWORDS.test(text);
}

function hasFollowupMention(lead) {
  return /qayta aloqa/i.test(`${lead.comment || ""} ${lead.note2 || ""}`);
}

/**
 * Izohdan sana topishga urinadi: "08/08", "08.08", "8/8" kabi formatlar.
 * Topilmasa null qaytaradi. Yil ko'rsatilmagani uchun "hozirgi yil" deb olinadi;
 * agar shu sana o'tib ketgan bo'lsa (masalan dekabrda yanvar sanasi yozilsa),
 * keyingi yilga o'tkaziladi.
 */
function extractFollowupDate(lead, now) {
  const text = `${lead.comment || ""} ${lead.note2 || ""}`;
  const match = text.match(/(\d{1,2})[.\/](\d{1,2})/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  let year = now.getFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (candidate.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 60) {
    // 60 kundan ko'proq o'tib ketgan bo'lsa, ehtimol keyingi yilga tegishli
    candidate = new Date(Date.UTC(year + 1, month - 1, day, 12, 0, 0));
  }
  return candidate;
}

/**
 * Har bir lead uchun: qanday sheet yangilanishlari va qanday Telegram
 * bildirishnomalari kerakligini hisoblaydi. Idempotent — bir xil holatda
 * qayta chaqirilsa, allaqachon bajarilgan narsani takrorlamaydi (buni
 * chaqiruvchi tomon `alreadyNotifiedToday` orqali nazorat qiladi).
 */
async function planActionsForLead(lead, now, alreadyNotifiedToday) {
  const updates = {};
  const notifications = []; // { type, managerKey, text }

  const created = toDate(lead.createdTime) || now;
  const ageDays = daysBetween(created, now);
  const ageHours = hoursBetween(created, now);
  const closed = isClosed(lead);

  // 0) Yangi qator — hali manager belgilanmagan bo'lsa, Nozima'ga beriladi
  // (birinchi aloqani ham, eski leadlarni ham Nozima olib boradi).
  if (!lead.manager) {
    updates.manager = MANAGERS.nozima.name;
    updates.stage = STAGES.NEW;
    if (!(await alreadyNotifiedToday(lead.id, "assigned_nozima"))) {
      notifications.push({
        type: "assigned_nozima",
        managerKey: "nozima",
        text: `🆕 Yangi lead: <b>${esc(lead.name)}</b>, ${esc(lead.phone)}, ${esc(
          lead.city
        )}. Birinchi aloqa qiling.`,
      });
    }
    // Shu tsiklda boshqa qoidalarni tekshirishga hojat yo'q — davom etamiz.
    return { updates, notifications };
  }

  if (closed) {
    // Yakunlangan lead — endi hech narsa qilinmaydi.
    return { updates, notifications };
  }

  const currentStage = lead.stage || STAGES.NEW;

  // 1) Yangi lead, ancha vaqt gaplashilmagan (status bo'sh) — Nozima'ga eslatma.
  if (
    currentStage === STAGES.NEW &&
    !lead.status &&
    ageHours >= RULES.newLeadReminderHours &&
    !(await alreadyNotifiedToday(lead.id, "new_reminder"))
  ) {
    notifications.push({
      type: "new_reminder",
      managerKey: "nozima",
      text: `⏰ Eslatma: <b>${esc(lead.name)}</b> (${esc(
        lead.phone
      )}) bilan hali gaplashilmagan (${Math.round(ageHours)} soat oldin tushgan).`,
    });
  }

  // 2) Izohda "qayta aloqa" borligi — Muslima bosqichiga o'tkaziladi.
  if (currentStage === STAGES.NEW && hasFollowupMention(lead)) {
    updates.manager = MANAGERS.muslima.name;
    updates.stage = STAGES.FOLLOWUP;
    const followupDate = extractFollowupDate(lead, now);
    if (followupDate) {
      updates.nextFollowup = followupDate.toISOString().slice(0, 10);
    }
    if (!(await alreadyNotifiedToday(lead.id, "assigned_muslima"))) {
      notifications.push({
        type: "assigned_muslima",
        managerKey: "muslima",
        text: `🔁 Qayta aloqa kerak: <b>${esc(lead.name)}</b> (${esc(lead.phone)}). Izoh: "${esc(
          lead.comment
        )}"${followupDate ? ` — reja sana: ${fmtDate(followupDate)}` : ""}`,
      });
    }
  }

  // 3) Muslima uchun: belgilangan qayta aloqa sanasi bugun bo'lsa — eslatma.
  if (currentStage === STAGES.FOLLOWUP && lead.nextFollowup) {
    const fu = toDate(lead.nextFollowup);
    if (fu && isSameLocalDay(fu, now) && !(await alreadyNotifiedToday(lead.id, "followup_today"))) {
      notifications.push({
        type: "followup_today",
        managerKey: "muslima",
        text: `📅 Bugun qayta aloqa qilish kerak: <b>${esc(lead.name)}</b> (${esc(lead.phone)}).`,
      });
    }

    // Sana o'tib ketgan, hali yopilmagan (izoh o'zgarmagan) — ertasiga Nozima'ga.
    if (fu && now.getTime() > fu.getTime() + RULES.followupGraceDays * 24 * 60 * 60 * 1000) {
      updates.manager = MANAGERS.nozima.name;
      updates.stage = STAGES.OLD;
      if (!(await alreadyNotifiedToday(lead.id, "escalate_overdue"))) {
        notifications.push({
          type: "escalate_overdue",
          managerKey: "nozima",
          text: `⚠️ Qayta aloqa sanasi (${fmtDate(
            fu
          )}) o'tib ketdi, hali bog'lanilmagan: <b>${esc(lead.name)}</b> (${esc(
            lead.phone
          )}). Endi siz bog'laning.`,
        });
      }
    }
  }

  // 4) 3 kundan keyin ham yakunlanmagan har qanday lead — Nozima'ga o'tadi.
  if (currentStage !== STAGES.OLD && ageDays >= RULES.oldLeadAfterDays) {
    updates.manager = MANAGERS.nozima.name;
    updates.stage = STAGES.OLD;
    if (!(await alreadyNotifiedToday(lead.id, "escalate_3days"))) {
      notifications.push({
        type: "escalate_3days",
        managerKey: "nozima",
        text: `📦 3 kundan beri yakunlanmagan: <b>${esc(lead.name)}</b> (${esc(
          lead.phone
        )}), ${Math.floor(ageDays)} kun oldin tushgan. Siz oling.`,
      });
    }
  }

  // 5) Status bor-u, sifat (Sifatli/Sifatsiz) belgilanmagan — aniqlik so'raladi.
  if (
    lead.status &&
    !lead.quality &&
    ageHours >= RULES.newLeadReminderHours &&
    !(await alreadyNotifiedToday(lead.id, "ask_quality"))
  ) {
    const respManagerKey = managerKeyByName(lead.manager) || "nozima";
    notifications.push({
      type: "ask_quality",
      managerKey: respManagerKey,
      text: `❓ Bu lead nima bo'ldi? <b>${esc(lead.name)}</b> (${esc(
        lead.phone
      )}) — sifatlimi yoki sifatsizmi? Qayta aloqa kerakmi?`,
    });
  }

  return { updates, notifications };
}

function managerKeyByName(name) {
  const found = Object.values(MANAGERS).find(
    (m) => m.name.toLowerCase() === String(name).toLowerCase()
  );
  return found ? found.key : null;
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Kunlik hisobot uchun statistika.
 */
function computeDailyStats(leads, now) {
  const today = leads.filter((l) => {
    const created = toDate(l.createdTime);
    return created && isSameLocalDay(created, now);
  });

  const contacted = today.filter((l) => l.status && l.status !== "");
  const quality = today.filter((l) => /sifatli$/i.test((l.quality || "").trim()) && !/sifatsiz/i.test(l.quality || ""));
  const nonQuality = today.filter((l) => /sifatsiz/i.test(l.quality || ""));

  const byManager = {};
  for (const key of Object.keys(MANAGERS)) {
    byManager[key] = { total: 0, contacted: 0, quality: 0, nonQuality: 0 };
  }
  for (const l of today) {
    const key = managerKeyByName(l.manager);
    if (!key || !byManager[key]) continue;
    byManager[key].total += 1;
    if (l.status) byManager[key].contacted += 1;
    if (/sifatsiz/i.test(l.quality || "")) byManager[key].nonQuality += 1;
    else if (/sifatli/i.test(l.quality || "")) byManager[key].quality += 1;
  }

  const pending = leads.filter(
    (l) => !isClosed(l) && (!l.status || !l.quality)
  );

  const qualityPct = today.length ? Math.round((quality.length / today.length) * 100) : 0;

  return {
    totalToday: today.length,
    contactedToday: contacted.length,
    qualityToday: quality.length,
    nonQualityToday: nonQuality.length,
    qualityPct,
    byManager,
    pending,
  };
}

module.exports = {
  planActionsForLead,
  computeDailyStats,
  isClosed,
  hasFollowupMention,
  extractFollowupDate,
  managerKeyByName,
  fmtDate,
  fmtDateTime,
  isSameLocalDay,
  toDate,
  esc,
};
