import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { config } from "../config/env.js";
import { log } from "../util/log.js";

export type DB = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let dbInstance: DB | null = null;

export function createPool(url: string, ssl: boolean): pg.Pool {
  const p = new pg.Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    // Neon cold start takes a few seconds; never hang forever on connect.
    connectionTimeoutMillis: 15_000,
    // A stuck query must not block the single-flight worker tick indefinitely.
    query_timeout: 60_000,
  });
  // Neon closes idle connections when its compute suspends. Without a listener the
  // pool's 'error' event is unhandled and crashes the whole process.
  p.on("error", (e) => log.warn("idle postgres client error", { err: e }));
  return p;
}

export function db(): DB {
  if (!dbInstance) {
    const c = config();
    pool = createPool(c.db.url, c.db.ssl);
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

export function getPool(): pg.Pool {
  db();
  return pool!;
}

/** Test helper: inject an existing pool. */
export function setDb(p: pg.Pool) {
  pool = p;
  dbInstance = drizzle(p, { schema });
}

export async function closeDb() {
  if (pool) await pool.end();
  pool = null;
  dbInstance = null;
}

export { schema };
