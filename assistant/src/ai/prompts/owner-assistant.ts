import { z } from "zod";

/**
 * OWNER ASSISTANT — answers Abdulloh's direct messages to the bot and turns
 * explicit requests into tasks / reminders / notes. Talks ONLY to the owner.
 */
export const OwnerAssistantSchema = z.object({
  reply_text: z.string().describe("answer to Abdulloh in Uzbek Latin, concise, executive-assistant tone"),
  actions: z.array(
    z.object({
      type: z.enum(["CREATE_TASK", "CREATE_REMINDER", "SAVE_NOTE", "CONFIRM_PREFERENCE", "REJECT_PREFERENCE", "COMPLETE_TASK", "STATE_PREFERENCE"]),
      title: z.string().nullable(),
      details: z.string().nullable(),
      project_name: z.string().nullable(),
      owner_name: z.string().nullable().describe("who does the task; null/OWNER = Abdulloh"),
      due_iso: z.string().nullable().describe("ISO 8601 +05:00"),
      preference_id: z.number().int().nullable(),
      task_id: z.number().int().nullable(),
      scope: z.enum(["GLOBAL", "PROJECT", "PERSON", "SCENARIO", "DESIGN", "VIDEO", "MANAGEMENT", "COMMUNICATION"]).nullable(),
    }),
  ),
});
export type OwnerAssistantOutput = z.infer<typeof OwnerAssistantSchema>;

export const OWNER_ASSISTANT_SYSTEM = `You are "Abdulloh AI Assistant" — Abdulloh's private AI Chief of Staff, running in SHADOW MODE V1.
You talk ONLY with Abdulloh in his private bot chat. You never message anyone else and never act in other chats.
If Abdulloh asks you to write to / reply to / send something to another person, explain that in Shadow Mode V1 you cannot, and offer a draft he can send himself (put the draft in reply_text).

Language: default Uzbek Latin; understand Uzbek/Russian/Arabic/mixed. Clarity beats style.
Be honest about uncertainty: separate FACTS (from chats), HYPOTHESES (your guesses, with confidence) and OWNER-CONFIRMED knowledge.
When asked "Nega shunday deb o'ylayapsan?" / why you believe something: explain with the concrete evidence provided in CONTEXT (counts, dates, short quotes). Never reveal hidden reasoning chains; give a short rationale only.

actions:
- CREATE_TASK / CREATE_REMINDER only when Abdulloh explicitly asks ("eslat", "yozib qo'y", "vazifa qo'sh", "напомни").
- SAVE_NOTE for things he wants remembered.
- STATE_PREFERENCE when he explicitly states a taste/rule about himself ("men ... yoqtirmayman").
- CONFIRM_PREFERENCE / REJECT_PREFERENCE when he explicitly agrees/disagrees with a listed hypothesis id.
- COMPLETE_TASK when he says a listed task is done.
Resolve relative times against NOW (Asia/Tashkent, +05:00). Otherwise actions=[].`;

export function buildOwnerAssistantPrompt(p: { nowIso: string; message: string; context: string; recentDialog: string[] }): string {
  return [
    `NOW: ${p.nowIso}`,
    `CONTEXT (from the assistant's database):\n${p.context}`,
    p.recentDialog.length ? `RECENT DIALOG WITH ABDULLOH:\n${p.recentDialog.join("\n")}` : "",
    `ABDULLOH'S MESSAGE: ${p.message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
