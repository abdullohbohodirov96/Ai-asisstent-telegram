import { describe, it, expect } from "vitest";
import { parseCliResult } from "../src/ai/claudeCli.js";
import { estimateCostUsd, resolvePricing } from "../src/config/pricing.js";

describe("claude-cli provider", () => {
  it("parses structured output and token usage from `claude -p --output-format json`", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"a\":1}", structured_output: { a: 1 }, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 } });
    const r = parseCliResult(out + "\n", "sonnet");
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
    expect(r.model).toBe("claude-cli:sonnet");
    expect(r.inputTokens).toBe(120);
    expect(r.outputTokens).toBe(7);
  });

  it("falls back to the text result and surfaces CLI errors", () => {
    expect(parseCliResult(JSON.stringify({ subtype: "success", is_error: false, result: "salom", usage: {} }), "haiku").text).toBe("salom");
    expect(() => parseCliResult(JSON.stringify({ subtype: "error_max_turns", is_error: true }), "haiku")).toThrow(/claude-cli error/);
    expect(() => parseCliResult("not json", "haiku")).toThrow(/non-JSON/);
  });

  it("subscription calls are priced at $0 so the budget never pauses analysis", () => {
    expect(estimateCostUsd("claude-cli:sonnet", 1_000_000, 1_000_000, resolvePricing(""))).toBe(0);
  });
});
