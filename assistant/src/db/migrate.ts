import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, closeDb } from "./client.js";
import { log } from "../util/log.js";

export function migrationsFolder(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "drizzle");
}

export async function runMigrations(): Promise<void> {
  await migrate(db(), { migrationsFolder: migrationsFolder() });
  log.info("migrations applied");
}

// CLI entry: `npm run migrate`
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then(() => closeDb())
    .catch(async (e) => {
      log.error("migration failed", { err: e });
      await closeDb();
      process.exit(1);
    });
}
