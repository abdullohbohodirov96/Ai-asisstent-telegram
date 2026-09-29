import { db, schema } from "../db/client.js";
import { sendToOwner, type SendOptions } from "../telegram/api.js";
import { ensureAssistantChat } from "../telegram/ingest.js";
import { log } from "../util/log.js";

/**
 * Send a message to the owner AND keep it in the assistant-chat history
 * (used as short dialog context). This is the only "speak" function the
 * application layer uses.
 */
export async function notifyOwner(text: string, opts: SendOptions = {}): Promise<number[]> {
  const ids = await sendToOwner(text, opts);
  try {
    const chatId = await ensureAssistantChat();
    for (const [i, tgId] of ids.entries()) {
      await db()
        .insert(schema.messages)
        .values({
          chatId,
          telegramMessageId: tgId,
          senderId: null,
          senderName: "Assistant",
          direction: "ASSISTANT_TO_OWNER",
          text: ids.length === 1 ? text : `[${i + 1}/${ids.length}] ${text.slice(0, 500)}`,
          sentAt: new Date(),
          analysisStatus: "SKIPPED",
        })
        .onConflictDoNothing();
    }
  } catch (e) {
    log.warn("could not record assistant message", { err: e });
  }
  return ids;
}
