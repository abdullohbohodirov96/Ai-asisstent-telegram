import { describe, it, expect } from "vitest";
import { toGeminiSchema } from "../src/ai/client.js";
import { isGemini3Plus } from "../src/ai/gemini.js";
import { BatchAnalysisSchema } from "../src/ai/prompts/batch-analysis.js";
import { ProfileUpdateSchema } from "../src/ai/prompts/learning.js";
import { OwnerAssistantSchema } from "../src/ai/prompts/owner-assistant.js";
import { QuestionEvaluationSchema } from "../src/ai/prompts/question-evaluator.js";

/** JSON Schema keywords accepted by Gemini's `responseJsonSchema` (structured output). */
const SUPPORTED = new Set(["type", "properties", "required", "items", "enum", "anyOf", "description", "minimum", "maximum", "minItems", "maxItems", "title", "format", "nullable", "additionalProperties", "prefixItems", "$ref", "$defs", "propertyOrdering"]);

function keywords(v: unknown, parentKey = "", acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keywords(x, "", acc));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (parentKey !== "properties") acc.add(k); // property names are data, not keywords
      keywords(x, k, acc);
    }
  }
  return acc;
}

describe("Gemini structured output schema", () => {
  it.each([
    ["BatchAnalysis", BatchAnalysisSchema],
    ["ProfileUpdate", ProfileUpdateSchema],
    ["OwnerAssistant", OwnerAssistantSchema],
    ["QuestionEvaluation", QuestionEvaluationSchema],
  ])("%s uses only keywords Gemini responseJsonSchema supports", (_n, schema) => {
    const js = toGeminiSchema(schema);
    const unsupported = [...keywords(js)].filter((k) => !SUPPORTED.has(k));
    expect(unsupported).toEqual([]);
    expect(js.type).toBe("object");
    // no type arrays (["string","null"]) — nullables are expressed with anyOf
    expect(JSON.stringify(js)).not.toMatch(/"type":\[/);
  });

  it("detects Gemini 3+ models (default temperature must be kept)", () => {
    expect(isGemini3Plus("gemini-3.5-flash-lite")).toBe(true);
    expect(isGemini3Plus("gemini-3-pro-preview")).toBe(true);
    expect(isGemini3Plus("gemini-2.5-flash-lite")).toBe(false);
    expect(isGemini3Plus("test-fast")).toBe(false);
  });
});
