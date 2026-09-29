# ABDULLOH AI ASSISTANT — SHADOW MODE V1

Shaxsiy **AI Chief of Staff**. Telegram Business chatlaringizni o'qiydi, tahlil qiladi, loyihalar, odamlar, vazifalar, va'dalar va qarorlarni kuzatadi. Vaqt o'tishi bilan **sizni o'rganadi**: boshqaruv uslubingizni, kreativ, ssenariy, dizayn va video didingizni. Bularni global va har bir loyiha bo'yicha alohida saqlaydi.

> **SHADOW MODE V1 — HARD RULE:** bot hech kimga sizning nomingizdan yozmaydi, vazifa yubormaydi, mijozga javob bermaydi. U **faqat sizga** (`OWNER_TELEGRAM_ID`) yozadi. Bu qoida kod darajasida qulflangan (`src/telegram/shadowGuard.ts`). `ALLOW_*` env flaglarni `true` qilsangiz ham ishlamaydi.

```
READ → UNDERSTAND → ASK → LEARN → REMEMBER → REPORT
```

---

## Arxitektura

```
Telegram ──POST /telegram/webhook──▶ as_telegram_updates (raw queue, update_id bo'yicha idempotent) ──200 OK darhol
                                            │  worker (har 30s) + tashqi cron (/internal/cron/analyze)
                                            ▼
                          as_messages (Neon — source of truth, hech narsa o'chirilmaydi)
                                            │  chat × 5 daqiqalik oyna
                                            ▼
                          as_message_batches ──▶ Gemini structured JSON (Zod) ──▶ tasks / commitments / decisions /
                                                                                  waiting / follow-ups / creative / feedback /
                                                                                  preferences + evidence / learning questions
                                            │
               09:00 / 13:00 / 18:00 ──▶ as_report_runs (sana+slot unique) ──▶ report ──▶ FAQAT OWNER
```

| Qatlam | Fayl |
|---|---|
| Env (yagona kirish nuqtasi) | `src/config/env.ts`, narxlar: `src/config/pricing.ts` |
| DB sxema + migratsiya | `src/db/schema.ts`, `drizzle/0000_init.sql` |
| Telegram (yagona chiqish nuqtasi + guard) | `src/telegram/api.ts`, `src/telegram/shadowGuard.ts` |
| Qabul qilish, edit, delete | `src/telegram/ingest.ts` |
| 5 daqiqalik batching | `src/engine/batcher.ts` |
| AI extraction + persist | `src/engine/analyzer.ts` |
| Confidence / preference engine | `src/engine/preferences.ts` |
| Learning questions (limit, follow-up) | `src/engine/questions.ts` |
| Profil o'rganish | `src/engine/learning.ts` |
| Promptlar (alohida) | `src/ai/prompts/*.ts` |
| Gemini provider / cost / budget | `src/ai/gemini.ts`, `src/ai/client.ts`, `src/ai/usage.ts` |
| Ovoz (provider interfeysi) | `src/transcription/provider.ts` |
| Reportlar + missed-report himoyasi | `src/reports/*.ts` |
| Owner chat, buyruqlar | `src/bot/owner.ts`, `src/bot/commands.ts` |

Barcha jadvallar `as_` prefiksli, shuning uchun bir Neon bazada boshqa loyihalar bilan to'qnashmaydi.

---

## Noldan deployment

### 1. Telegram bot yaratish
1. [@BotFather](https://t.me/BotFather) → `/newbot` (yoki mavjud assistant botingizdan foydalaning). **Lead-nazorat botining tokenini ishlatmang**: bitta botda faqat bitta webhook bo'lishi mumkin.
2. Tokenni oling → `TELEGRAM_BOT_TOKEN`.
3. BotFather → `/mybots` → bot → **Bot Settings → Business Mode → Turn on**.
4. O'z Telegram ID'ingizni oling: [@userinfobot](https://t.me/userinfobot)'ga yozing → `OWNER_TELEGRAM_ID`.

### 2. Telegram Business accountga ulash
Telegram Premium kerak. Telegram → **Settings → Telegram Business → Chatbots** → bot username'ini kiriting.
- **Chats:** "All private chats" yoki kerakli chatlarni tanlang (istisnolarni ham qo'yish mumkin).

### 3. Business bot permissions (muhim)
Ulash oynasida bot huquqlari chiqadi. **Shadow Mode uchun hammasini o'chiring**, xususan **"Reply to messages"** ni. Bot faqat xabarlarni qabul qiladi. Hatto huquq yoqilgan bo'lsa ham kod har qanday javobni bloklaydi. Holatni `/shadow` buyrug'i ko'rsatadi.

### 4. Neon database
1. [neon.tech](https://neon.tech) → New Project (region: Frankfurt yoki yaqinrog'i).
2. **Connection string** (pooled bo'lishi mumkin) → `DATABASE_URL`. `?sslmode=require` qoldiring.

### 5. Migratsiyalar
Server har startda migratsiyani avtomatik bajaradi (`RUN_MIGRATIONS_ON_START=true`). Qo'lda bajarish:
```bash
cd assistant
npm ci --include=dev && npm run build
DATABASE_URL="postgres://..." npm run migrate
```
Sxema o'zgarsa: `src/db/schema.ts` → `npm run db:generate` → yangi SQL `drizzle/` ichida paydo bo'ladi.

### 6. Gemini API key
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key** → `GEMINI_API_KEY`.
Billing yoqilmagan (free tier) kalit ham ishlaydi, lekin limitlari past. `gemini-3.5-flash-lite` sizning hisobingizda borligini AI Studio'dagi model ro'yxatidan tekshiring.

### 7. Render
1. [render.com](https://render.com) → **New → Web Service** → GitHub repo `Ai-asisstent-telegram` → branch `shadow-mode-v1` (keyinchalik `main`).
2. **Root Directory:** `assistant`
3. **Runtime:** Node
4. **Build Command:** `npm ci --include=dev && npm run build`
5. **Start Command:** `npm start`
6. **Health Check Path:** `/health`
7. **Environment:** `.env.example` dagi barcha o'zgaruvchilar. Kamida quyidagilar kerak: `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `TELEGRAM_WEBHOOK_SECRET`, `DATABASE_URL`, `GEMINI_API_KEY`, `CRON_SECRET`, `TIMEZONE=Asia/Tashkent`.
   Secretlarni yaratish: `openssl rand -hex 32`.

> Lead-nazorat boti (Vercel, repo root) bunga tegmaydi. Assistent `assistant/` papkasida alohida servis. `.vercelignore` bu papkani Vercel'dan chiqarib qo'yadi.

### 8. Webhook
```bash
TOKEN="<TELEGRAM_BOT_TOKEN>"
URL="https://<render-servis>.onrender.com/telegram/webhook"
SECRET="<TELEGRAM_WEBHOOK_SECRET>"

curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"$URL\",\"secret_token\":\"$SECRET\",\"drop_pending_updates\":false,
       \"allowed_updates\":[\"message\",\"callback_query\",\"business_connection\",\"business_message\",\"edited_business_message\",\"deleted_business_messages\"]}"

curl -s "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```
Menyu buyruqlari (ixtiyoriy):
```bash
curl -s "https://api.telegram.org/bot$TOKEN/setMyCommands" -H 'Content-Type: application/json' -d '{"commands":[
 {"command":"brief","description":"Umumiy holat"},{"command":"today","description":"Bugungi ishlar"},
 {"command":"tasks","description":"Aktiv vazifalar"},{"command":"waiting","description":"Kimdan nima kutilyapti"},
 {"command":"projects","description":"Loyihalar"},{"command":"people","description":"Odamlar"},
 {"command":"learn","description":"Men haqimda bilganlaring"},{"command":"questions","description":"Ochiq savollar"},
 {"command":"report","description":"To`liq hisobot"},{"command":"cost","description":"AI xarajat"},
 {"command":"shadow","description":"Shadow Mode holati"}]}'
```

### 9. Cron (Render free rejimda uxlab qolmasligi va reportlar o'tkazib yuborilmasligi uchun)
Render free web service 15 daqiqa trafik bo'lmasa uxlaydi. In-process scheduler ham bor, lekin [cron-job.org](https://cron-job.org) (bepul) orqali tashqi cron qo'ying:

| Vazifa | URL | Jadval (Asia/Tashkent) |
|---|---|---|
| Tahlil + recovery | `POST https://<servis>/internal/cron/analyze` | har 5 daqiqa |
| Ertalab | `POST https://<servis>/internal/cron/report/morning` | 09:00 |
| Kunduzi | `POST https://<servis>/internal/cron/report/midday` | 13:00 |
| Kechqurun | `POST https://<servis>/internal/cron/report/evening` | 18:00 |

Header: `Authorization: Bearer <CRON_SECRET>` (yoki `X-Cron-Secret: <CRON_SECRET>`).
```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<servis>/internal/cron/analyze
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<servis>/internal/cron/report/morning
```
Report endpointlari idempotent: bir slot ikki marta yuborilmaydi (`as_report_runs` unique `sana+slot`). Vaqti kelmagan slot `NOT_DUE` qaytaradi (majburlash uchun `?force=1`). Server uxlab qolib, report vaqtini o'tkazib yuborsa, uyg'onganda eng so'nggi o'tkazib yuborilgan slotni yuboradi. Undan oldingi oynalar ham shu reportga qo'shiladi, shuning uchun eski brieflar ketma-ket spam bo'lib kelmaydi.

### 10. Test qilish
```bash
curl https://<servis>/health          # {"ok":true,"db":true,"shadowMode":true,...}
```
1. Botga `/start`, keyin `/shadow` yozing.
2. Business chatda kimdir sizga yozsin, siz javob bering, masalan: "Bobur, ertaga video tayyor bo'lsin".
3. 5–6 daqiqa kuting (yoki `/internal/cron/analyze` ni chaqiring) → `/debug_last_batch` → `/tasks`.
4. Loyiha noma'lum bo'lsa, botdan savol keladi. Tugma yoki matn bilan javob bering.
5. `/report` — hozirning o'zida to'liq hisobot. `/cost` — xarajat.

Lokal testlar (Postgres kerak):
```bash
cd assistant
createdb shadow_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/shadow_test npm test
npm run typecheck && npm run build
```

### 11. Shadow Mode ishlayotganini tekshirish
- `/shadow`: V1 lock ON, `ALLOW_*` amalda `false`, bloklangan urinishlar soni, business connection'da reply huquqi bor-yo'qligi.
- DB: `select method, chat_id, allowed, reason from as_outbound_audit order by id desc;` — har bir `sendMessage` shu yerda. `allowed=true` qatorlarning hammasida `chat_id` = sizning ID'ingiz bo'lishi kerak.
- Kod: botdagi barcha chiqish `src/telegram/api.ts → callTelegram()` orqali o'tadi. Guard `business_connection_id` bo'lgan har qanday chaqiruvni, owner'dan boshqa `chat_id`ni va allow-list'da yo'q metodlarni (`forwardMessage`, `editMessageText`, `deleteMessage`, …) rad etadi.
- Webhook javobi har doim `{"ok":true}`. Telegram webhook javobiga metod qo'yish imkoniyati ham ishlatilmaydi.
- Testlar: `test/shadow.test.ts`, `test/e2e.test.ts`.

### 12. Gemini modelni almashtirish
Faqat env orqali, kodga tegmasdan:
```
GEMINI_MODEL_FAST=gemini-2.5-flash-lite
GEMINI_MODEL_DEEP=gemini-2.5-flash-lite
AI_PRICING_JSON={"gemini-2.5-flash-lite":{"input":0.1,"output":0.4}}
```
Render → Environment → Save → avtomatik redeploy. `/cost` joriy modellarni ko'rsatadi. `FAST` batch tahlil, savol baholash va owner so'rovlari uchun, `DEEP` reportlar va profil o'rganish uchun ishlatiladi.

---

## Buyruqlar (faqat OWNER)
`/brief` `/today` `/tasks` `/waiting` `/projects` `/people` `/learn` `/questions` (`/questions next` — keyingi savolni hozir so'rash) `/report` `/cost` `/shadow`
Debug: `/debug_last_batch` `/debug_memory` `/debug_project <nom>` `/debug_usage`

Oddiy matn yoki ovoz bilan ham yozish mumkin: "ertaga 10:00 da Boburga qo'ng'iroqni eslat", "nega #3 deb o'ylayapsan?", "men uzun intro'larni yoqtirmayman".

## Xarajat (taxminiy)
Bitta 5 daqiqalik batch taxminan 3–5k input va ~1k output token oladi. `gemini-3.5-flash-lite` narxida (≈$0.30 / $2.50 per 1M, [tekshiring](https://ai.google.dev/pricing)) bu ≈$0.003–0.004 qiladi. Report har biri ≈$0.01. $5/oy byudjet kuniga ~40 faol suhbat oynasi va 3 ta reportga yetadi. `gemini-2.5-flash-lite` taxminan 3–4 barobar arzon. 50%, 80% va 100% da ogohlantirish keladi. 100% da fon tahlili pauzaga o'tadi (xabarlar saqlanib turadi), reportlar va sizning so'rovlaringiz esa ishlashda davom etadi.

## Kelajak (V2+)
Reply draft → approval → autopilot. Bular `shadowGuard.ts` dagi `SHADOW_MODE_V1_LOCK` ni kod orqali ochishni va alohida approval modulini talab qiladi. Env bilan yoqib bo'lmaydi.
