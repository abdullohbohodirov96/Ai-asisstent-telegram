import { config } from "./config/env.js";
import { buildServer } from "./server.js";
import { runMigrations } from "./db/migrate.js";
import { closeDb } from "./db/client.js";
import { wireApp } from "./wire.js";
import { ensureOwnerPerson } from "./telegram/ingest.js";
import { startWorker, stopWorker } from "./jobs/worker.js";
import { log } from "./util/log.js";

async function main() {
  const c = config();
  wireApp();
  if (c.runMigrationsOnStart) await runMigrations();
  await ensureOwnerPerson();
  if (!c.telegram.webhookSecret)
    log.warn(c.isProd ? "TELEGRAM_WEBHOOK_SECRET is empty — webhook REJECTS all updates (503) until it is set" : "TELEGRAM_WEBHOOK_SECRET is empty");
  if (!c.cronSecret) log.warn("CRON_SECRET is empty — cron endpoints are disabled");
  if (c.aiProvider === "gemini" && !c.gemini.apiKey) log.warn("GEMINI_API_KEY is empty — AI features will fail (messages are still stored)");

  const app = buildServer();
  await app.listen({ port: c.port, host: "0.0.0.0" });
  log.info("assistant started", { port: c.port, shadowMode: true, modelFast: c.gemini.modelFast, modelDeep: c.gemini.modelDeep });
  startWorker();

  const shutdown = async () => {
    stopWorker();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Node's default handlers print the raw error (Drizzle errors embed bound query params,
// i.e. private message text). Log through the scrubbing logger instead.
process.on("unhandledRejection", (e) => log.error("unhandled rejection", { err: e }));
process.on("uncaughtException", (e) => {
  log.error("uncaught exception", { err: e });
  process.exit(1);
});

main().catch((e) => {
  log.error("fatal startup error", { err: e });
  process.exit(1);
});
