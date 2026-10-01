/**
 * Minimal structured logger that scrubs secrets. Never pass raw private
 * message text to it — log ids and counts instead.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\d{6,12}:[A-Za-z0-9_-]{30,}/g, // telegram bot token
  /AIza[0-9A-Za-z_-]{20,}/g, // google api key
  /github_pat_[A-Za-z0-9_]+/g,
  /postgres(?:ql)?:\/\/[^\s"']+/g, // connection strings
  /(api[_-]?key|token|secret|password)=([^&\s"']+)/gi,
];

/**
 * Drizzle wraps driver errors as `Failed query: <sql>\nparams: <values>`. The params are
 * bound values — private message text, AI output, names — so they must never reach logs.
 */
const QUERY_PARAMS_RE = /\n?params:[\s\S]*$/;

function describeError(e: Error): string {
  // DrizzleQueryError: keep the query shape and the driver's own message, drop the values.
  const anyE = e as Error & { query?: unknown; params?: unknown; cause?: unknown };
  if (typeof anyE.query === "string" && "params" in anyE) {
    const cause = anyE.cause instanceof Error ? ` — ${anyE.cause.message}` : "";
    return `${e.name}: query failed (${anyE.query.slice(0, 120)})${cause}`;
  }
  return `${e.name}: ${e.message}`;
}

export function scrub(input: unknown): string {
  let s = typeof input === "string" ? input : input instanceof Error ? describeError(input) : safeJson(input);
  s = s.replace(QUERY_PARAMS_RE, " params: [REDACTED]");
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m, k) => (typeof k === "string" && m.includes("=") ? `${k}=[REDACTED]` : "[REDACTED]"));
  return s.length > 500 ? s.slice(0, 500) + "…" : s;
}

/** Short, scrubbed error text for DB `error` columns. */
export function errorText(e: unknown, max = 300): string {
  return scrub(e).slice(0, max);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

type Level = "debug" | "info" | "warn" | "error";
const quiet = process.env.NODE_ENV === "test";

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (quiet && level !== "error") return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  if (meta) for (const [k, v] of Object.entries(meta)) line[k] = typeof v === "number" || typeof v === "boolean" ? v : scrub(v);
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};
