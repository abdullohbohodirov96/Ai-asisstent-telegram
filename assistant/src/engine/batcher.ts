import { and, eq, isNull, sql, inArray, desc } from "drizzle-orm";
import { config } from "../config/env.js";
import { db, schema } from "../db/client.js";
import { windowStart } from "../util/time.js";

/**
 * 5-minute batching: unanalysed business messages are grouped by CHAT + TIME WINDOW.
 * One closed window of one chat = one AI analysis call.
 * Window length = ANALYSIS_BATCH_MINUTES.
 */
export async function formBatches(now: Date = new Date()): Promise<number[]> {
  const minutes = config().batchMinutes;
  const d = db();
  return d.transaction(async (tx) => {
    const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(771001) as ok`);
    if (!(lock.rows[0] as any)?.ok) return [];

    // Deleted-before-analysis messages are kept (never hard-deleted) but not analysed.
    await tx
      .update(schema.messages)
      .set({ analysisStatus: "SKIPPED" })
      .where(and(eq(schema.messages.analysisStatus, "PENDING"), isNull(schema.messages.batchId), sql`${schema.messages.deletedAt} is not null`));

    const pending = await tx
      .select({ id: schema.messages.id, chatId: schema.messages.chatId, sentAt: schema.messages.sentAt })
      .from(schema.messages)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.messages.chatId))
      .where(and(eq(schema.messages.analysisStatus, "PENDING"), isNull(schema.messages.batchId), eq(schema.chats.kind, "BUSINESS")));

    const groups = new Map<string, { chatId: number; start: Date; ids: number[] }>();
    for (const m of pending) {
      const start = windowStart(m.sentAt, minutes);
      const end = new Date(start.getTime() + minutes * 60_000);
      if (end.getTime() > now.getTime()) continue; // window still open
      const key = `${m.chatId}:${start.getTime()}`;
      const g = groups.get(key) ?? { chatId: m.chatId, start, ids: [] };
      g.ids.push(m.id);
      groups.set(key, g);
    }

    const batchIds: number[] = [];
    for (const g of groups.values()) {
      const existing = await tx
        .select()
        .from(schema.messageBatches)
        .where(and(eq(schema.messageBatches.chatId, g.chatId), eq(schema.messageBatches.windowStart, g.start)))
        .orderBy(desc(schema.messageBatches.seq));
      let batchId: number;
      const reusable = existing.find((b) => b.status === "PENDING");
      if (reusable) {
        batchId = reusable.id;
      } else {
        // late messages for an already-analysed window get a new sequence number
        const seq = existing.length ? existing[0].seq + 1 : 0;
        const [b] = await tx
          .insert(schema.messageBatches)
          .values({ chatId: g.chatId, windowStart: g.start, windowEnd: new Date(g.start.getTime() + minutes * 60_000), seq })
          .returning({ id: schema.messageBatches.id });
        batchId = b.id;
      }
      await tx
        .update(schema.messages)
        .set({ batchId })
        .where(and(inArray(schema.messages.id, g.ids), isNull(schema.messages.batchId)));
      batchIds.push(batchId);
    }
    return batchIds;
  });
}
