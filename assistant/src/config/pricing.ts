/**
 * Model prices in USD per 1M tokens. These are ESTIMATES used only for the
 * cost dashboard and budget alerts. Override/extend without code changes via
 * AI_PRICING_JSON env, e.g. {"gemini-3.5-flash-lite":{"input":0.1,"output":0.4}}.
 * Verify current prices at https://ai.google.dev/pricing.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // third-party listing (pricepertoken.com, Sep 2026) — verify on ai.google.dev/pricing
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  // Fallback for any model not listed above (conservative, so the budget is not underestimated).
  "*": { input: 0.3, output: 2.5 },
};

export function resolvePricing(overrideJson: string): Record<string, ModelPrice> {
  if (!overrideJson) return DEFAULT_PRICING;
  try {
    const parsed = JSON.parse(overrideJson) as Record<string, ModelPrice>;
    return { ...DEFAULT_PRICING, ...parsed };
  } catch {
    return DEFAULT_PRICING;
  }
}

export function priceFor(model: string, table: Record<string, ModelPrice>): ModelPrice {
  // Local Claude Code CLI runs on the owner's subscription: no per-token charge.
  if (model.startsWith("claude-cli:")) return table[model] ?? { input: 0, output: 0 };
  return table[model] ?? table["*"] ?? { input: 0, output: 0 };
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, table: Record<string, ModelPrice>): number {
  const p = priceFor(model, table);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
