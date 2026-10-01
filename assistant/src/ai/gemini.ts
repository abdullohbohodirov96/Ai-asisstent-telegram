import { GoogleGenAI } from "@google/genai";
import { config } from "../config/env.js";
import type { AIProvider, AIRequest, AIResponse, ModelTier } from "./provider.js";

/** Gemini implementation. Model names come ONLY from env (GEMINI_MODEL_FAST / GEMINI_MODEL_DEEP). */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private client: GoogleGenAI;

  constructor(apiKey = config().gemini.apiKey) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    // Request timeout (ms): a hung call would otherwise block the worker tick forever.
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000 } });
  }

  modelFor(tier: ModelTier): string {
    const g = config().gemini;
    return tier === "DEEP" ? g.modelDeep : tier === "TRANSCRIBE" ? g.modelTranscribe : g.modelFast;
  }

  async generate(req: AIRequest): Promise<AIResponse> {
    const model = this.modelFor(req.tier);
    const parts: any[] = [];
    if (req.audio) parts.push({ inlineData: { mimeType: req.audio.mimeType, data: req.audio.data.toString("base64") } });
    parts.push({ text: req.user });

    const baseConfig: Record<string, unknown> = { systemInstruction: req.system };
    // Google recommends keeping Gemini 3.x at its default temperature (1.0); lower values
    // can cause looping / degraded output. Older models keep the low default.
    const temperature = req.temperature ?? (isGemini3Plus(model) ? undefined : 0.2);
    if (temperature !== undefined) baseConfig.temperature = temperature;
    if (req.jsonSchema) {
      baseConfig.responseMimeType = "application/json";
      baseConfig.responseJsonSchema = req.jsonSchema;
    }

    let res;
    try {
      res = await this.client.models.generateContent({ model, contents: [{ role: "user", parts }], config: baseConfig });
    } catch (e: any) {
      // Some models reject complex schemas: retry once with JSON mode only
      // (the schema is still enforced by Zod validation downstream).
      // Only a schema rejection falls back; other 400s (bad key, unknown model, …) are
      // rethrown instead of silently doubling the number of paid calls.
      const status = e?.status ?? e?.code;
      if (req.jsonSchema && (status === 400 || status === undefined) && /schema/i.test(String(e?.message))) {
        const { responseJsonSchema, ...rest } = baseConfig;
        res = await this.client.models.generateContent({ model, contents: [{ role: "user", parts }], config: rest });
      } else {
        throw e;
      }
    }

    const usage = res.usageMetadata ?? {};
    return {
      text: res.text ?? "",
      model,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    };
  }
}

/** gemini-3*, gemini-3.5-*, gemini-4* … (anything with major version >= 3). */
export function isGemini3Plus(model: string): boolean {
  const m = /gemini-(\d+)/i.exec(model);
  return m ? Number(m[1]) >= 3 : false;
}
