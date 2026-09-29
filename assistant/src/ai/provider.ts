export type AIPurpose =
  | "BATCH_ANALYSIS"
  | "TRANSCRIPTION"
  | "LEARNING"
  | "QUESTION_EVALUATION"
  | "REPORT"
  | "USER_QUERY";

export type ModelTier = "FAST" | "DEEP" | "TRANSCRIBE";

export interface AIRequest {
  purpose: AIPurpose;
  tier: ModelTier;
  system: string;
  user: string;
  /** JSON schema for structured output (derived from Zod). */
  jsonSchema?: Record<string, unknown>;
  audio?: { data: Buffer; mimeType: string };
  temperature?: number;
}

export interface AIResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Provider abstraction so Gemini can be swapped (or mocked in tests). */
export interface AIProvider {
  readonly name: string;
  modelFor(tier: ModelTier): string;
  generate(req: AIRequest): Promise<AIResponse>;
}
