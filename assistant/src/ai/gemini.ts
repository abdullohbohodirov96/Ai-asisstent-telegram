import { GoogleGenAI } from "@google/genai";
import { config } from "../config/env.js";
import type { AIProvider, AIRequest, AIResponse, ModelTier } from "./provider.js";

/** Gemini implementation. Model names come ONLY from env (GEMINI_MODEL_FAST / GEMINI_MODEL_DEEP). */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private client: GoogleGenAI;

  constructor(apiKey = config().gemini.apiKey) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    this.client = new GoogleGenAI({ apiKey });
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

    const baseConfig: Record<string, unknown> = {
      systemInstruction: req.system,
      temperature: req.temperature ?? 0.2,
    };
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
      const status = e?.status ?? e?.code;
      if (req.jsonSchema && (status === 400 || /schema/i.test(String(e?.message)))) {
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
