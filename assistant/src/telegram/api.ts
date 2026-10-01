import { config } from "../config/env.js";
import { db, schema } from "../db/client.js";
import { log } from "../util/log.js";
import { checkOutbound, OWNER_VERIFIED, ShadowModeViolation } from "./shadowGuard.js";

const HTTP_TIMEOUT_MS = 30_000;

/**
 * The ONLY place in the codebase that talks to the Telegram Bot API.
 * Every call passes through the Shadow Mode guard and is audited.
 */

export type Transport = (method: string, params: Record<string, unknown>) => Promise<any>;

const httpTransport: Transport = async (method, params) => {
  const res = await fetch(`https://api.telegram.org/bot${config().telegram.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    // A hung request would otherwise block the single-flight worker tick forever.
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result;
};

let transport: Transport = httpTransport;
/** Test hook. */
export function setTransport(t: Transport | null) {
  transport = t ?? httpTransport;
}

async function audit(method: string, chatId: unknown, allowed: boolean, reason: string) {
  try {
    await db()
      .insert(schema.outboundAudit)
      .values({ method, chatId: Number.isFinite(Number(chatId)) ? Number(chatId) : null, allowed, reason });
  } catch (e) {
    log.warn("outbound audit insert failed", { err: e });
  }
}

export async function callTelegram<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const decision = checkOutbound(method, params);
  const isDelivery = method === "sendMessage" || !decision.allowed;
  if (isDelivery) await audit(method, params.chat_id, decision.allowed, decision.reason);
  if (!decision.allowed) {
    log.warn("SHADOW MODE BLOCKED outbound call", { method, reason: decision.reason });
    throw new ShadowModeViolation(method, decision.reason);
  }
  // Object spread copies symbol keys too; drop the owner-verified marker explicitly.
  const { [OWNER_VERIFIED]: _verified, ...clean } = params as Record<PropertyKey, unknown>;
  return transport(method, clean as Record<string, unknown>);
}

const TG_LIMIT = 3900;

export function splitText(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export interface SendOptions {
  replyMarkup?: unknown;
  replyToMessageId?: number;
}

/** Send plain text to the owner's private chat. Returns the telegram message ids. */
export async function sendToOwner(text: string, opts: SendOptions = {}): Promise<number[]> {
  const ownerId = config().telegram.ownerId;
  const ids: number[] = [];
  const parts = splitText(text);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const params: Record<string, unknown> = { chat_id: ownerId, text: parts[i], disable_web_page_preview: true };
    if (last && opts.replyMarkup) params.reply_markup = opts.replyMarkup;
    if (i === 0 && opts.replyToMessageId) params.reply_parameters = { message_id: opts.replyToMessageId, allow_sending_without_reply: true };
    const res = await callTelegram<{ message_id: number }>("sendMessage", params);
    if (res?.message_id) ids.push(res.message_id);
  }
  return ids;
}

export async function answerOwnerCallback(callbackQueryId: string, fromId: number, text?: string) {
  if (fromId !== config().telegram.ownerId) return; // never respond to non-owners
  await callTelegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text, [OWNER_VERIFIED]: true });
}

export async function downloadFile(fileId: string): Promise<{ data: Buffer; path: string }> {
  const file = await callTelegram<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${config().telegram.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), path: file.file_path };
}
