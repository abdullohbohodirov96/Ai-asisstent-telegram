import { config } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { closeDb } from "./db/client.js";
import { ensureOwnerPerson } from "./telegram/ingest.js";
import { tick } from "./jobs/worker.js";
import { wireApp } from "./wire.js";
import { log } from "./util/log.js";

/**
 * Laptop worker (`npm run worker`). Render (DISABLE_WORKER=true) only receives the webhook
 * and stores updates in Neon. When this process runs, it drains everything that piled up —
 * owner commands, business-chat batches, learning questions, missed reports — and then keeps
 * ticking until it is stopped (Ctrl+C). Nothing is lost while the laptop is off.
 */
let stopping = false;

async function main() {
  const c = config();
  wireApp();
  if (c.runMigrationsOnStart) await runMigrations();
  await ensureOwnerPerson();
  log.info("laptop worker started", { provider: c.aiProvider, intervalSeconds: c.workerIntervalSeconds });

  while (!stopping) {
    const r = await tick({ maxBatches: 10 }).catch((e) => {
      log.error("tick failed", { err: e });
      return null;
    });
    if (r) log.info("tick", { updates: r.updates, batchesFormed: r.batchesFormed, batchesAnalysed: r.batchesAnalysed, errors: r.errors.length });
    // Backlog: keep going immediately while there is work; otherwise wait for the next tick.
    const busy = r && (r.updates > 0 || r.batchesAnalysed > 0) && r.errors.length === 0;
    if (!busy) await sleep(c.workerIntervalSeconds * 1000);
  }
  await closeDb();
}

let wake: (() => void) | null = null;
function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wake = null;
      resolve();
    }
    wake = done;
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
function stop() {
  if (stopping) process.exit(0); // second Ctrl+C: exit immediately
  stopping = true;
  log.info("stopping after the current tick (Ctrl+C again to force)");
  wake?.();
}
process.on("unhandledRejection", (e) => log.error("unhandled rejection", { err: e }));

main().catch(async (e) => {
  log.error("fatal worker error", { err: e });
  await closeDb().catch(() => undefined);
  process.exit(1);
});
