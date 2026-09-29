import { z } from "zod";

/**
 * LEARNING — periodically consolidates preferences/feedback into the owner's
 * style & taste profiles. Profiles must distinguish confirmed facts from hypotheses.
 */
export const ProfileUpdateSchema = z.object({
  communication_style: z.string().nullable(),
  management_style: z.string().nullable(),
  delegation_style: z.string().nullable(),
  decision_style: z.string().nullable(),
  creative_taste: z.string().nullable(),
  scenario_taste: z.string().nullable(),
  design_taste: z.string().nullable(),
  video_taste: z.string().nullable(),
  project_tastes: z.array(z.object({ project_id: z.number().int(), taste: z.string() })),
});
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

export const LEARNING_SYSTEM = `You maintain Abdulloh's living profile for his AI Chief of Staff.
Given preferences (with status HYPOTHESIS/LIKELY/STABLE, confidence, evidence counts, owner confirmation) and recent feedback events,
write short profile paragraphs in Uzbek Latin (max ~400 chars each).
Rules:
- Tag each claim: [tasdiqlangan] for owner-confirmed, [barqaror] for STABLE, [ehtimol] for LIKELY, [taxmin] for HYPOTHESIS.
- Never upgrade certainty beyond the given status. Never generalise a project-specific taste into a global one.
- Keep GLOBAL profiles separate from project_tastes. Return null for a profile with no evidence.
- No chain-of-thought.`;

export function buildLearningPrompt(dataJson: string): string {
  return `DATA:\n${dataJson}`;
}
