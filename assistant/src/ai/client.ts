import { z } from "zod";
import type { AIProvider, AIPurpose, ModelTier } from "./provider.js";
import { recordUsage, isBackgroundPaused } from "./usage.js";
import { log } from "../util/log.js";

let provider: AIProvider | null = null;
let providerFactory: (() => AIProvider) | null = null;

export function setProviderFactory(f: () => AIProvider) {
  providerFactory = f;
  provider = null;
}
export function setProvider(p: AIProvider | null) {
  provider = p;
}
export function getProvider(): AIProvider {
  if (!provider) {
    if (!providerFactory) throw new Error("AI provider not configured");
    provider = providerFactory();
  }
  return provider;
}

export class BudgetPausedError extends Error {
  constructor() {
    super("Monthly AI budget exhausted; background analysis paused");
    this.name = "BudgetPausedError";
  }
}

/** Purposes that keep working when the budget is exhausted. */
const ESSENTIAL: Set<AIPurpose> = new Set(["REPORT", "USER_QUERY", "QUESTION_EVALUATION", "TRANSCRIPTION"]);

export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  return stripKeys(js) as Record<string, unknown>;
}

function stripKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "$schema" || k === "additionalProperties") continue;
      // zod adds ±MAX_SAFE_INTEGER bounds to .int(); they only add noise for the model
      if ((k === "minimum" || k === "maximum") && typeof val === "number" && Math.abs(val) > 1e12) continue;
      out[k] = stripKeys(val);
    }
    // {type:["string","null"]} → anyOf form, which Gemini's JSON-schema mode handles consistently
    if (Array.isArray(out.type)) {
      const { type, ...rest } = out;
      return { ...rest, anyOf: (type as string[]).map((t) => ({ type: t })) };
    }
    return out;
  }
  return v;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("AI response is not JSON");
  }
}

export interface StructuredCall<T extends z.ZodType> {
  purpose: AIPurpose;
  tier: ModelTier;
  system: string;
  user: string;
  schema: T;
  batchId?: number | null;
  audio?: { data: Buffer; mimeType: string };
}

export async function generateStructured<T extends z.ZodType>(call: StructuredCall<T>): Promise<{ data: z.infer<T>; model: string }> {
  if (!ESSENTIAL.has(call.purpose) && (await isBackgroundPaused())) throw new BudgetPausedError();
  const p = getProvider();
  const jsonSchema = toGeminiSchema(call.schema);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await p.generate({
      purpose: call.purpose,
      tier: call.tier,
      system: call.system,
      user: attempt === 0 ? call.user : `${call.user}\n\nOLDINGI JAVOB SXEMAGA MOS KELMADI. Faqat sxemaga mos to'g'ri JSON qaytaring.`,
      jsonSchema,
      audio: call.audio,
    });
    let ok = false;
    try {
      const parsed = call.schema.safeParse(extractJson(res.text));
      if (parsed.success) {
        ok = true;
        await recordUsage({ provider: p.name, model: res.model, purpose: call.purpose, inputTokens: res.inputTokens, outputTokens: res.outputTokens, batchId: call.batchId });
        return { data: parsed.data, model: res.model };
      }
      lastErr = new Error(`schema validation failed: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")).join(", ")}`);
    } catch (e) {
      lastErr = e;
    } finally {
      if (!ok) await recordUsage({ provider: p.name, model: res.model, purpose: call.purpose, inputTokens: res.inputTokens, outputTokens: res.outputTokens, batchId: call.batchId, success: false });
    }
    log.warn("structured AI output invalid, retrying", { purpose: call.purpose, attempt });
  }
  throw lastErr instanceof Error ? lastErr : new Error("AI structured call failed");
}

export async function generateText(call: { purpose: AIPurpose; tier: ModelTier; system: string; user: string; audio?: { data: Buffer; mimeType: string } }): Promise<{ text: string; model: string }> {
  if (!ESSENTIAL.has(call.purpose) && (await isBackgroundPaused())) throw new BudgetPausedError();
  const p = getProvider();
  const res = await p.generate({ ...call });
  await recordUsage({ provider: p.name, model: res.model, purpose: call.purpose, inputTokens: res.inputTokens, outputTokens: res.outputTokens });
  return { text: res.text, model: res.model };
}
