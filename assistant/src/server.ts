import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config/env.js";
import { enqueueUpdate } from "./telegram/ingest.js";
import { tick, kick } from "./jobs/worker.js";
import { runDueReports, runSlot } from "./reports/service.js";
import { localDate, slotTime, SLOTS, type Slot } from "./util/time.js";
import { getPool } from "./db/client.js";
import { SHADOW_MODE_V1_LOCK } from "./telegram/shadowGuard.js";
import { log } from "./util/log.js";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cronAuthorized(headers: Record<string, unknown>): boolean {
  const secret = config().cronSecret;
  if (!secret) return false;
  const auth = String(headers["authorization"] ?? "");
  const header = String(headers["x-cron-secret"] ?? "");
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : header;
  return provided.length > 0 && safeEqual(provided, secret);
}

export function buildServer(): FastifyInstance {
  // Fastify's own request logging is off: it could leak private message bodies or secrets.
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.get("/health", async () => {
    let dbOk = false;
    try {
      await getPool().query("select 1");
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return { ok: dbOk, db: dbOk, shadowMode: SHADOW_MODE_V1_LOCK, time: new Date().toISOString() };
  });

  app.post("/telegram/webhook", async (req, reply) => {
    const expected = config().telegram.webhookSecret;
    if (expected) {
      const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
      if (!safeEqual(got, expected)) return reply.code(401).send({ ok: false });
    } else if (config().isProd) {
      // Fail closed: without the secret anyone who knows the URL could forge updates
      // "from" the owner (run commands, inject fake business messages, burn the AI budget).
      return reply.code(503).send({ ok: false });
    }
    try {
      const fresh = await enqueueUpdate(req.body);
      if (fresh) kick();
    } catch (e) {
      // DB down: return 500 so Telegram retries later — the update is not lost.
      log.error("webhook enqueue failed", { err: e });
      return reply.code(500).send({ ok: false });
    }
    // IMPORTANT: never answer the webhook with a Bot API method payload (that would be an outbound action).
    return reply.code(200).send({ ok: true });
  });

  app.post("/internal/cron/analyze", async (req, reply) => {
    if (!cronAuthorized(req.headers as Record<string, unknown>)) return reply.code(401).send({ ok: false });
    const result = await tick({ maxBatches: 10 });
    return { ok: true, ...result };
  });

  app.post<{ Params: { slot: string }; Querystring: { force?: string } }>("/internal/cron/report/:slot", async (req, reply) => {
    if (!cronAuthorized(req.headers as Record<string, unknown>)) return reply.code(401).send({ ok: false });
    const slot = req.params.slot.toUpperCase() as Slot;
    if (!SLOTS.includes(slot)) return reply.code(400).send({ ok: false, error: "slot must be morning|midday|evening" });
    const now = new Date();
    const date = localDate(now);
    if (req.query.force === "1") return { ok: true, slot, result: await runSlot(date, slot, "cron", now, { force: true }) };
    if (slotTime(date, slot).toJSDate() > now) return { ok: true, slot, result: "NOT_DUE" };
    // Same path as the in-process scheduler: if earlier slots were missed (host slept),
    // they are folded into the latest due report instead of being sent out of order later.
    const results = await runDueReports("cron", now);
    return { ok: true, slot, result: results[slot] ?? "ALREADY", results };
  });

  return app;
}
