# Dunyo Bunyo — Lead nazorat boti (Telegram + Google Sheets)

Bu bot ROP (sotuv bo'limi rahbari) vazifasini bajaradi: Google Sheets'dagi
leadlarni kuzatadi, ularni bosqichlar bo'yicha managerlarga (Nozima →
Muslima → Nozima) taqsimlaydi, eslatma va savollarni Telegram guruhga ismi
bilan chaqirib yozadi, va har kuni soat 20:00 da to'liq hisobot beradi.

## Qanday ishlaydi

- **Nozima** — yangi tushgan leadlar bilan birinchi aloqa, shuningdek
  3 kundan keyin ham yakunlanmagan yoki qayta aloqa muddati o'tib ketgan
  (sovuq) leadlar bilan ham ishlaydi.
- **Muslima** — "qayta aloqa" kerak bo'lgan leadlar (2-3 kontakt).
- Bot har 2 soatda sheetni tekshiradi, kerak bo'lsa manager belgilaydi,
  eslatma yozadi, yoki lead haqida aniqlik so'raydi (savolga guruhda
  **Reply** qilib javob berilsa, javob avtomatik sheetga yoziladi).
- Har kuni soat 20:00 (Toshkent) da kunlik hisobot guruhga yuboriladi.

Sheetning mavjud ustunlariga (A–U) tegilmaydi — bot faqat **V, W, X, Y, Z**
ustunlariga o'zi boshqaradigan ma'lumotlarni (manager, bosqich, keyingi
aloqa sanasi) yozadi.

---

## 1-qadam: Google Sheets uchun xizmat hisobi (service account)

1. https://console.cloud.google.com ga kiring, yangi loyiha yarating (yoki
   mavjudini tanlang).
2. **APIs & Services → Library** dan "Google Sheets API" ni toping va
   **Enable** qiling.
3. **APIs & Services → Credentials → Create Credentials → Service account**
   orqali yangi xizmat hisobi yarating (nomi muhim emas, masalan
   `lead-bot`).
4. Yaratilgan xizmat hisobini oching → **Keys → Add Key → Create new key →
   JSON** — fayl kompyuteringizga yuklanadi. Ichidan `client_email` va
   `private_key` qiymatlarini oling.
5. Google Sheets faylini (https://docs.google.com/spreadsheets/d/1ds54-...)
   oching → **Ulashish (Share)** → `client_email` manzilini **Editor**
   huquqi bilan qo'shing (aks holda bot sheetni o'qiy olmaydi/yoza olmaydi).

## 2-qadam: Telegram tomoni

Bot tokeningiz allaqachon bor. Qo'shimcha kerak bo'ladigan narsa:

1. Botni guruhga qo'shing va **admin** qiling (xabar o'chirmasligi uchun
   admin shart emas, lekin ba'zi guruhlarda oddiy a'zo xabar yoza olmasligi
   mumkin — shu sabab admin qilib qo'yish tavsiya etiladi).
2. Guruh chat ID (`-1004321325004`) allaqachon bizda bor.
3. `TELEGRAM_WEBHOOK_SECRET` va `CRON_SECRET` uchun o'zingiz tasodifiy matn
   o'ylab toping (masalan `openssl rand -hex 16` buyrug'i bilan) va
   `.env.example`, `vercel.json` ichiga shu qiymatni yozing.

## 3-qadam: Kodni GitHub'ga yuklash

```bash
cd dunyabunya-lead-bot
git init
git add .
git commit -m "lead bot"
```

GitHub'da yangi bo'sh repository yarating va shu papkani o'sha repoga
push qiling.

## 4-qadam: Vercel'ga deploy

1. https://vercel.com → **Add New → Project** → GitHub repongizni tanlang.
2. **Storage → Create Database → KV** orqali Vercel KV (Upstash Redis)
   ulang va uni shu loyihaga bog'lang — bu kerakli `KV_*` environment
   variable'larni avtomatik qo'shib qo'yadi.
3. **Settings → Environment Variables** bo'limida quyidagilarni qo'shing
   (`.env.example` faylidagi ro'yxat bo'yicha):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_GROUP_CHAT_ID` = `-1004321325004`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `SPREADSHEET_ID` = `1ds54-zGkC_m7XUAozAW-fcx2CYSFh3QoZ4prpGGqf3g`
   - `SHEET_NAME` = `Лист1`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY` (JSON fayldagi `private_key` qiymatini to'liq
     qo'shtirnoq bilan qo'ying, `\n` belgilarini o'zgartirmang)
   - `CRON_SECRET` = `YOUR_CRON_SECRET`
   (vercel.json va .env.example ga o'zingiz yozib qo'yasiz)
4. Deploy tugaguncha kuting.

## 5-qadam: Webhookni ulash

Deploy tugagach, brauzerda bir marta oching:

```
https://SIZNING-DOMEN.vercel.app/api/setup-webhook?secret=YOUR_CRON_SECRET
```

`"ok": true` javobini ko'rsangiz, webhook ulandi.

## 6-qadam: Har 2 soatlik tekshiruvni yoqish (GitHub Actions)

Vercel'ning bepul (Hobby) rejasida cron kuniga faqat 1 marta ishlaydi,
shuning uchun har 2 soatlik tekshiruvni GitHub Actions orqali tashqaridan
chaqiramiz (`.github/workflows/check-leads-cron.yml` fayli allaqachon
tayyor).

GitHub repo → **Settings → Secrets and variables → Actions** bo'limida:
- `VERCEL_DOMAIN` = `sizning-domen.vercel.app` (https:// siz)
- `CRON_SECRET` = xuddi Vercel'dagi bilan bir xil qiymat

Shu ikkitasini qo'shsangiz, bot avtomatik har 2 soatda ishlay boshlaydi.
(Agar keyinchalik Vercel Pro'ga o'tsangiz, buning o'rniga `vercel.json`
ichiga qo'shimcha cron qo'shib, GitHub Actions'siz ham qilsa bo'ladi.)

## Managerlar qanday javob berishi kerak

Bot guruhga savol yozganda (masalan "Bu lead nima bo'ldi?"), manager o'sha
xabarga Telegram'ning **Reply** (javob berish, tepaga strelka) tugmasi
bilan javob yozishi kerak — oddiy yangi xabar emas. Shunda bot avtomatik
javobni tegishli lead qatoriga sheetga yozadi.

## Tekshirish (test qilish)

- `https://domen.vercel.app/api/cron/check-leads?secret=YOUR_CRON_SECRET` —
  qo'lda ochib, guruhga xabar kelayotganini tekshiring.
- `https://domen.vercel.app/api/cron/daily-report?secret=YOUR_CRON_SECRET` —
  kunlik hisobotni qo'lda sinab ko'ring.

## Keyinchalik moslashtirish

Barcha qoidalar (3 kun, 2 soat, eslatma matnlari) `lib/config.js` va
`lib/logic.js` fayllarida — kerak bo'lsa shu yerdan o'zgartirasiz.
