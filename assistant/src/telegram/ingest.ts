import { and, eq, inArray, lte, sql, asc } from "drizzle-orm";
import { config } from "../config/env.js";
import { db, schema } from "../db/client.js";
import { log } from "../util/log.js";
import { backoffMs } from "../util/retry.js";

/**
 * Stage 1 (webhook, fast): persist the raw update, idempotent on update_id.
 * Stage 2 (worker): normalise into chats/persons/messages and dispatch owner interactions.
 */

export type OwnerHandler = {
  onOwnerMessage: (messageRowId: number, raw: any) => Promise<void>;
  onOwnerCallback: (cb: any) => Promise<void>;
};

let ownerHandler: OwnerHandler | null = null;
export function registerOwnerHandler(h: OwnerHandler) {
  ownerHandler = h;
}

export function updateKind(update: any): string {
  for (const k of [
    "business_connection",
    "business_message",
    "edited_business_message",
    "deleted_business_messages",
    "message",
    "edited_message",
    "callback_query",
  ]) {
    if (update && update[k]) return k;
  }
  return "other";
}

/** Returns true when newly stored, false when it was a duplicate. */
export async function enqueueUpdate(update: any): Promise<boolean> {
  if (!update || typeof update.update_id !== "number") return false;
  const rows = await db()
    .insert(schema.telegramUpdates)
    .values({ updateId: update.update_id, kind: updateKind(update), payload: update })
    .onConflictDoNothing()
    .returning({ id: schema.telegramUpdates.updateId });
  return rows.length > 0;
}

const MAX_UPDATE_ATTEMPTS = 5;

export async function processPendingUpdates(limit = 50): Promise<number> {
  const d = db();
  const pending = await d
    .select()
    .from(schema.telegramUpdates)
    .where(and(inArray(schema.telegramUpdates.status, ["PENDING", "FAILED"]), lte(schema.telegramUpdates.nextAttemptAt, sql`now()`), sql`${schema.telegramUpdates.attempts} < ${MAX_UPDATE_ATTEMPTS}`))
    .orderBy(asc(schema.telegramUpdates.updateId))
    .limit(limit);

  let done = 0;
  for (const u of pending) {
    // claim (protects against a concurrent worker / cron call)
    const claimed = await d
      .update(schema.telegramUpdates)
      .set({ status: "PROCESSING", attempts: u.attempts + 1 })
      .where(and(eq(schema.telegramUpdates.updateId, u.updateId), inArray(schema.telegramUpdates.status, ["PENDING", "FAILED"])))
      .returning({ id: schema.telegramUpdates.updateId });
    if (!claimed.length) continue;
    try {
      const status = await handleUpdate(u.payload);
      await d
        .update(schema.telegramUpdates)
        .set({ status, processedAt: new Date(), error: null })
        .where(eq(schema.telegramUpdates.updateId, u.updateId));
      done++;
    } catch (e) {
      log.error("update processing failed", { updateId: u.updateId, kind: u.kind, err: e });
      await d
        .update(schema.telegramUpdates)
        .set({ status: "FAILED", error: String((e as Error)?.message ?? e).slice(0, 300), nextAttemptAt: new Date(Date.now() + backoffMs(u.attempts + 1, 10_000)) })
        .where(eq(schema.telegramUpdates.updateId, u.updateId));
    }
  }
  return done;
}

/** Reset updates stuck in PROCESSING (process crashed mid-way). */
export async function recoverStuckUpdates(): Promise<void> {
  await db()
    .update(schema.telegramUpdates)
    .set({ status: "PENDING" })
    .where(and(eq(schema.telegramUpdates.status, "PROCESSING"), lte(schema.telegramUpdates.receivedAt, new Date(Date.now() - 10 * 60_000))));
}

// ------------------------------------------------------------------ dispatch

export async function handleUpdate(update: any): Promise<"DONE" | "IGNORED"> {
  const kind = updateKind(update);
  switch (kind) {
    case "business_connection":
      await upsertBusinessConnection(update.business_connection);
      return "DONE";
    case "business_message":
      return (await storeBusinessMessage(update.business_message)) ? "DONE" : "IGNORED";
    case "edited_business_message":
      return (await applyEdit(update.edited_business_message)) ? "DONE" : "IGNORED";
    case "deleted_business_messages":
      return (await applyDeletion(update.deleted_business_messages)) ? "DONE" : "IGNORED";
    case "message":
      return handleBotMessage(update.message);
    case "callback_query": {
      const cb = update.callback_query;
      if (cb?.from?.id !== config().telegram.ownerId) return "IGNORED";
      if (ownerHandler) await ownerHandler.onOwnerCallback(cb);
      return "DONE";
    }
    default:
      return "IGNORED";
  }
}

// ------------------------------------------------------------------ business connection

export async function upsertBusinessConnection(bc: any) {
  const canReply = Boolean(bc.can_reply ?? bc.rights?.can_reply);
  await db()
    .insert(schema.businessConnections)
    .values({
      id: bc.id,
      userId: bc.user?.id,
      userChatId: bc.user_chat_id ?? null,
      isEnabled: bc.is_enabled !== false,
      canReply,
      rights: bc.rights ?? null,
    })
    .onConflictDoUpdate({
      target: schema.businessConnections.id,
      set: { isEnabled: bc.is_enabled !== false, canReply, rights: bc.rights ?? null, updatedAt: new Date() },
    });
  if (bc.user?.id !== config().telegram.ownerId) {
    log.warn("business connection from a non-owner account; its messages will be ignored", { connection: "redacted" });
  } else if (canReply) {
    log.warn("business connection has reply rights; Shadow Mode still blocks all replies. Consider disabling reply rights in Telegram.");
  }
}

async function connectionBelongsToOwner(connectionId: string | undefined): Promise<boolean> {
  if (!connectionId) return false;
  const [bc] = await db().select().from(schema.businessConnections).where(eq(schema.businessConnections.id, connectionId));
  // If we never saw the business_connection update (e.g. bot connected before deploy),
  // accept it: Telegram only delivers business updates for accounts that connected THIS bot,
  // and the webhook is secret-protected. Still, a known non-owner connection is rejected.
  if (!bc) return true;
  return bc.userId === config().telegram.ownerId && bc.isEnabled;
}

// ------------------------------------------------------------------ persons / chats

function displayName(u: any): string {
  if (!u) return "Noma'lum";
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
}

export async function upsertPerson(u: any, isOwner = false): Promise<number> {
  const d = db();
  const values = {
    telegramUserId: u.id as number,
    name: displayName(u),
    username: u.username ?? null,
    isOwner,
  };
  const rows = await d
    .insert(schema.persons)
    .values(values)
    .onConflictDoUpdate({
      target: schema.persons.telegramUserId,
      set: { username: values.username, updatedAt: new Date() },
    })
    .returning({ id: schema.persons.id });
  return rows[0].id;
}

export async function ensureOwnerPerson(): Promise<number> {
  const ownerId = config().telegram.ownerId;
  const [p] = await db().select().from(schema.persons).where(eq(schema.persons.telegramUserId, ownerId));
  if (p) return p.id;
  const id = await upsertPerson({ id: ownerId, first_name: "Abdulloh" }, true);
  await db().insert(schema.userProfile).values({ telegramUserId: ownerId, name: "Abdulloh" }).onConflictDoNothing();
  return id;
}

export async function ensureAssistantChat(): Promise<number> {
  const ownerId = config().telegram.ownerId;
  const personId = await ensureOwnerPerson();
  return upsertChat("ASSISTANT", { id: ownerId, first_name: "Abdulloh" }, personId, null);
}

async function upsertChat(kind: "BUSINESS" | "ASSISTANT", chat: any, personId: number | null, connectionId: string | null): Promise<number> {
  const rows = await db()
    .insert(schema.chats)
    .values({ telegramChatId: chat.id, kind, title: chat.title ?? displayName(chat), personId, businessConnectionId: connectionId })
    .onConflictDoUpdate({
      target: [schema.chats.kind, schema.chats.telegramChatId],
      set: { businessConnectionId: connectionId, updatedAt: new Date() },
    })
    .returning({ id: schema.chats.id });
  return rows[0].id;
}

// ------------------------------------------------------------------ messages

export function mediaTypeOf(m: any): string | null {
  for (const k of ["voice", "audio", "video_note", "video", "photo", "document", "sticker", "animation", "contact", "location", "poll"]) {
    if (m[k]) return k;
  }
  return null;
}

function fileIdOf(m: any): string | null {
  if (m.voice) return m.voice.file_id;
  if (m.audio) return m.audio.file_id;
  if (m.video_note) return m.video_note.file_id;
  if (m.document) return m.document.file_id;
  return null;
}

export async function storeBusinessMessage(m: any): Promise<number | null> {
  if (!(await connectionBelongsToOwner(m.business_connection_id))) return null;
  const ownerId = config().telegram.ownerId;
  await ensureOwnerPerson();

  const fromOwner = m.from?.id === ownerId;
  // In a business chat, chat.id is the counterpart's user id (private chat).
  const counterpart = m.chat?.type === "private" ? (fromOwner ? m.chat : m.from) : null;
  const personId = counterpart ? await upsertPerson(counterpart) : null;
  if (!fromOwner && m.from && m.from.id !== counterpart?.id) await upsertPerson(m.from);

  const chatId = await upsertChat("BUSINESS", m.chat, personId, m.business_connection_id);
  const rows = await db()
    .insert(schema.messages)
    .values({
      chatId,
      telegramMessageId: m.message_id,
      senderId: m.from?.id ?? null,
      senderName: displayName(m.from),
      direction: fromOwner ? "OUTGOING" : "INCOMING",
      text: m.text ?? m.caption ?? null,
      mediaType: mediaTypeOf(m),
      fileId: fileIdOf(m),
      replyToMessageId: m.reply_to_message?.message_id ?? null,
      businessConnectionId: m.business_connection_id,
      sentAt: new Date((m.date ?? Math.floor(Date.now() / 1000)) * 1000),
      analysisStatus: "PENDING",
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });
  return rows[0]?.id ?? null;
}

export async function applyEdit(m: any): Promise<boolean> {
  if (!(await connectionBelongsToOwner(m.business_connection_id))) return false;
  const d = db();
  const [chat] = await d
    .select()
    .from(schema.chats)
    .where(and(eq(schema.chats.kind, "BUSINESS"), eq(schema.chats.telegramChatId, m.chat.id)));
  if (!chat) {
    await storeBusinessMessage(m);
    return true;
  }
  const [existing] = await d
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.chatId, chat.id), eq(schema.messages.telegramMessageId, m.message_id)));
  if (!existing) {
    await storeBusinessMessage(m);
    return true;
  }
  const newText = m.text ?? m.caption ?? null;
  if (newText === existing.text) return true;
  const editedAt = new Date((m.edit_date ?? Math.floor(Date.now() / 1000)) * 1000);
  await d.insert(schema.messageVersions).values({ messageId: existing.id, text: existing.text, editedAt: existing.editedAt ?? existing.sentAt });
  await d.update(schema.messages).set({ text: newText, editedAt }).where(eq(schema.messages.id, existing.id));
  if (existing.analysisStatus === "DONE") {
    // Already-analysed evidence changed: flag dependent learning evidence for review.
    await d
      .update(schema.learningEvidence)
      .set({ needsReview: true })
      .where(sql`${existing.id} = ANY(${schema.learningEvidence.messageIds})`);
    await d
      .update(schema.tasks)
      .set({ staleEvidence: true })
      .where(sql`${existing.id} = ANY(${schema.tasks.evidenceMessageIds})`);
  }
  return true;
}

export type DeletionListener = (messageIds: number[]) => Promise<void>;
let deletionListener: DeletionListener | null = null;
export function registerDeletionListener(l: DeletionListener) {
  deletionListener = l;
}

export async function applyDeletion(del: any): Promise<boolean> {
  if (!(await connectionBelongsToOwner(del.business_connection_id))) return false;
  const d = db();
  const [chat] = await d
    .select()
    .from(schema.chats)
    .where(and(eq(schema.chats.kind, "BUSINESS"), eq(schema.chats.telegramChatId, del.chat.id)));
  if (!chat) return true;
  const ids: number[] = (del.message_ids ?? []).map(Number);
  if (!ids.length) return true;
  const rows = await d
    .update(schema.messages)
    .set({ deletedAt: new Date() })
    .where(and(eq(schema.messages.chatId, chat.id), inArray(schema.messages.telegramMessageId, ids)))
    .returning({ id: schema.messages.id });
  if (rows.length && deletionListener) await deletionListener(rows.map((r) => r.id));
  return true;
}

// ------------------------------------------------------------------ bot private chat

async function handleBotMessage(m: any): Promise<"DONE" | "IGNORED"> {
  const ownerId = config().telegram.ownerId;
  // Only the owner's private chat with the bot is served. Everyone else is silently ignored
  // (Shadow Mode: the bot never writes to anyone but the owner).
  if (m.chat?.type !== "private" || m.from?.id !== ownerId || m.chat.id !== ownerId) return "IGNORED";
  const personId = await ensureOwnerPerson();
  const chatId = await upsertChat("ASSISTANT", m.chat, personId, null);
  const rows = await db()
    .insert(schema.messages)
    .values({
      chatId,
      telegramMessageId: m.message_id,
      senderId: ownerId,
      senderName: displayName(m.from),
      direction: "OWNER_TO_ASSISTANT",
      text: m.text ?? m.caption ?? null,
      mediaType: mediaTypeOf(m),
      fileId: fileIdOf(m),
      replyToMessageId: m.reply_to_message?.message_id ?? null,
      sentAt: new Date((m.date ?? Math.floor(Date.now() / 1000)) * 1000),
      analysisStatus: "SKIPPED",
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });
  let rowId = rows[0]?.id;
  if (!rowId) {
    // Row exists => this is a retry of a failed update (duplicate deliveries are
    // already filtered by update_id), so handle it again.
    const [existing] = await db()
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.chatId, chatId), eq(schema.messages.telegramMessageId, m.message_id)));
    rowId = existing.id;
  }
  if (ownerHandler) await ownerHandler.onOwnerMessage(rowId, m);
  return "DONE";
}
