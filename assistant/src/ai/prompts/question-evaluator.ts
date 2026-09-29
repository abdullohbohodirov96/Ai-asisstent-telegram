import { z } from "zod";
import { Scope } from "./batch-analysis.js";

/**
 * QUESTION EVALUATOR — decides whether Abdulloh's reply answers an open
 * learning question, whether the answer is sufficient, and what was learned.
 */
export const QuestionEvaluationSchema = z.object({
  is_answer: z.boolean().describe("false if the message is about something else entirely"),
  sufficient: z.boolean().describe("true if the answer gives a concrete, usable reason/fact"),
  answer_summary: z.string().nullable().describe("the answer restated concisely in Uzbek"),
  project_name: z.string().nullable().describe("for PROJECT/NEW_PROJECT questions: the project the owner named"),
  yes_no: z.enum(["YES", "NO", "UNCLEAR"]).nullable().describe("for yes/no questions"),
  role: z.string().nullable().describe("for ROLE questions"),
  learned: z
    .array(
      z.object({
        scope: Scope,
        project_scoped: z.boolean(),
        statement: z.string().describe("what we now know about Abdulloh, in Uzbek; stated by him so it is confirmed"),
        confirms_preference_id: z.number().int().nullable(),
        rejects_preference_id: z.number().int().nullable(),
      }),
    )
    .describe("owner-confirmed learnings extracted from the answer"),
  follow_up_question: z
    .string()
    .nullable()
    .describe("if NOT sufficient: ONE focused follow-up with concrete options, e.g. 'Ko'proq qaysi tomoni: hook, syujet, juda reklamaviyligi yoki dialog?'"),
  acknowledgement: z.string().describe("very short Uzbek acknowledgement to send back, e.g. 'Tushundim, saqladim.'"),
});
export type QuestionEvaluation = z.infer<typeof QuestionEvaluationSchema>;

export const QUESTION_EVALUATOR_SYSTEM = `You evaluate Abdulloh's reply to a learning question asked by his AI Chief of Staff.
Replies may be Uzbek/Russian/mixed, typed or voice-transcribed. Output strings in Uzbek Latin.
- is_answer=false if the reply is clearly unrelated (a new request, a command, small talk).
- sufficient=true only if the reply gives a concrete fact or reason (e.g. "Juda reklamaga o'xshab ketgan, real odam bilan boshlanishi kerak").
- Vague replies ("prosto yoqmadi", "bilmadim", "shunchaki") are NOT sufficient: produce ONE focused follow-up question offering 3-4 concrete options.
- If FOLLOW-UPS LEFT is 0, do not produce a follow-up (set null) even when insufficient.
- learned: only what Abdulloh actually said (these become owner-confirmed). Keep project-specific tastes project_scoped=true.
- If the reply explicitly agrees with a listed hypothesis, set confirms_preference_id; if it explicitly denies it, set rejects_preference_id.
- No chain-of-thought.`;

export function buildQuestionEvaluationPrompt(p: {
  kind: string;
  question: string;
  context: unknown;
  previousAnswers: string[];
  answer: string;
  followUpsLeft: number;
  hypotheses: { id: number; statement: string }[];
  projects: string[];
}): string {
  return [
    `QUESTION KIND: ${p.kind}`,
    `QUESTION: ${p.question}`,
    `CONTEXT: ${JSON.stringify(p.context).slice(0, 1500)}`,
    `KNOWN PROJECTS: ${p.projects.join(", ") || "-"}`,
    `RELATED HYPOTHESES: ${p.hypotheses.map((h) => `id=${h.id} ${h.statement}`).join(" | ") || "-"}`,
    p.previousAnswers.length ? `PREVIOUS ANSWERS: ${p.previousAnswers.join(" | ")}` : "",
    `FOLLOW-UPS LEFT: ${p.followUpsLeft}`,
    `ABDULLOH'S REPLY: ${p.answer}`,
  ]
    .filter(Boolean)
    .join("\n");
}
