import { z } from "zod";

/**
 * Centralised, validated configuration. Nothing else in the codebase reads
 * process.env directly (except tests), so secrets have exactly one entry point.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM format kerak");

const EnvSchema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().default(3000),

  TELEGRAM_BOT_TOKEN: z.string().min(10),
  OWNER_TELEGRAM_ID: z.coerce.number().int().positive(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(""),

  DATABASE_URL: z.string().min(5),
  DATABASE_SSL: bool(true),

  /** gemini = Google API key (server); claude-cli = local `claude -p` with the owner's Claude subscription (laptop worker). */
  AI_PROVIDER: z.enum(["gemini", "claude-cli"]).default("gemini"),
  CLAUDE_CLI_PATH: z.string().default("claude"),
  CLAUDE_MODEL_FAST: z.string().default("sonnet"),
  CLAUDE_MODEL_DEEP: z.string().default("sonnet"),
  CLAUDE_CLI_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(300),
  /** Thinking effort for `claude -p` (low|medium|high). Low = faster, fewer subscription tokens. */
  CLAUDE_EFFORT: z.enum(["low", "medium", "high"]).default("low"),

  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL_FAST: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_MODEL_DEEP: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_MODEL_TRANSCRIBE: z.string().optional().default(""),
  /** JSON: {"model-name":{"input":0.1,"output":0.4}} USD per 1M tokens. Overrides src/config/pricing.ts defaults. */
  AI_PRICING_JSON: z.string().optional().default(""),

  TIMEZONE: z.string().default("Asia/Tashkent"),
  REPORT_MORNING: hhmm.default("09:00"),
  REPORT_MIDDAY: hhmm.default("13:00"),
  REPORT_EVENING: hhmm.default("18:00"),

  ANALYSIS_BATCH_MINUTES: z.coerce.number().int().min(1).max(120).default(5),
  CRON_SECRET: z.string().optional().default(""),

  MONTHLY_AI_BUDGET_USD: z.coerce.number().min(0).default(5),
  /** When monthly budget is exhausted, pause non-essential background AI (batch analysis, profile learning). */
  BUDGET_HARD_STOP: bool(true),
  DAILY_MAX_LEARNING_QUESTIONS: z.coerce.number().int().min(0).max(50).default(5),
  /** Learning questions are only sent within these Tashkent hours. */
  QUESTION_HOURS_START: z.coerce.number().int().min(0).max(23).default(8),
  QUESTION_HOURS_END: z.coerce.number().int().min(1).max(24).default(22),

  /** Transcribe voice notes arriving in *business* chats (costs tokens). Owner voice to the bot is always transcribed. */
  TRANSCRIBE_BUSINESS_VOICE: bool(false),

  /** In-process worker tick (seconds). External cron is the backup when the host sleeps. */
  WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
  RUN_MIGRATIONS_ON_START: bool(true),
  DISABLE_WORKER: bool(false),

  // --- Shadow mode feature flags (V1: hard-disabled in code regardless of value) ---
  ALLOW_AUTOREPLY: bool(false),
  ALLOW_DELEGATION: bool(false),
  ALLOW_PUBLISH: bool(false),
});

export type AppConfig = ReturnType<typeof buildConfig>;

function buildConfig(env: z.infer<typeof EnvSchema>) {
  return {
    nodeEnv: env.NODE_ENV,
    isProd: env.NODE_ENV === "production",
    port: env.PORT,
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN,
      ownerId: env.OWNER_TELEGRAM_ID,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    },
    db: { url: env.DATABASE_URL, ssl: env.DATABASE_SSL },
    aiProvider: env.AI_PROVIDER,
    claudeCli: {
      path: env.CLAUDE_CLI_PATH,
      modelFast: env.CLAUDE_MODEL_FAST,
      modelDeep: env.CLAUDE_MODEL_DEEP,
      timeoutMs: env.CLAUDE_CLI_TIMEOUT_SECONDS * 1000,
      effort: env.CLAUDE_EFFORT,
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY,
      modelFast: env.GEMINI_MODEL_FAST,
      modelDeep: env.GEMINI_MODEL_DEEP,
      modelTranscribe: env.GEMINI_MODEL_TRANSCRIBE || env.GEMINI_MODEL_FAST,
      pricingJson: env.AI_PRICING_JSON,
    },
    timezone: env.TIMEZONE,
    reports: { MORNING: env.REPORT_MORNING, MIDDAY: env.REPORT_MIDDAY, EVENING: env.REPORT_EVENING },
    batchMinutes: env.ANALYSIS_BATCH_MINUTES,
    cronSecret: env.CRON_SECRET,
    budget: { monthlyUsd: env.MONTHLY_AI_BUDGET_USD, hardStop: env.BUDGET_HARD_STOP },
    questions: {
      dailyMax: env.DAILY_MAX_LEARNING_QUESTIONS,
      hoursStart: env.QUESTION_HOURS_START,
      hoursEnd: env.QUESTION_HOURS_END,
      maxFollowUps: 2,
    },
    transcribeBusinessVoice: env.TRANSCRIBE_BUSINESS_VOICE,
    workerIntervalSeconds: env.WORKER_INTERVAL_SECONDS,
    runMigrationsOnStart: env.RUN_MIGRATIONS_ON_START,
    disableWorker: env.DISABLE_WORKER,
    flagsRequested: {
      allowAutoreply: env.ALLOW_AUTOREPLY,
      allowDelegation: env.ALLOW_DELEGATION,
      allowPublish: env.ALLOW_PUBLISH,
    },
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only print variable NAMES, never values.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Env konfiguratsiya xato yoki yetishmaydi: ${names}`);
  }
  return buildConfig(parsed.data);
}

let cached: AppConfig | null = null;
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
/** Test helper. */
export function setConfig(c: AppConfig) {
  cached = c;
}
