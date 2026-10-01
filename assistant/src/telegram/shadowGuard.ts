import { config } from "../config/env.js";

/**
 * SHADOW MODE V1 — HARD RULE.
 *
 * The assistant may talk ONLY to the owner's private chat with the bot.
 * It must never:
 *   - reply in a connected Telegram Business chat (no business_connection_id on any call),
 *   - send tasks to employees, write to clients, post to channels/groups,
 *   - edit/delete/forward anything on the owner's behalf.
 *
 * ALLOW_AUTOREPLY / ALLOW_DELEGATION / ALLOW_PUBLISH env flags are read but
 * IGNORED in V1: this constant locks them off. Unlocking requires a code change
 * (a future V2 approval/autopilot module), not an env tweak.
 */
export const SHADOW_MODE_V1_LOCK = true as const;

export class ShadowModeViolation extends Error {
  constructor(
    public readonly method: string,
    public readonly reason: string,
  ) {
    super(`Shadow Mode blocked ${method}: ${reason}`);
    this.name = "ShadowModeViolation";
  }
}

/** Methods that deliver content into a chat and therefore need chat_id == owner. */
const OWNER_ONLY_SEND_METHODS = new Set(["sendMessage", "sendChatAction"]);

/**
 * Methods that do not deliver content to any chat. Kept minimal on purpose:
 * webhook/command management (setWebhook, deleteWebhook, setMyCommands, …) is done
 * manually with curl, never by the running service — a compromised code path must not
 * be able to redirect the bot's updates elsewhere.
 */
const NON_DELIVERY_METHODS = new Set([
  "getMe",
  "getFile",
  "answerCallbackQuery", // only shows a toast to the button presser; presser must be verified as owner
  "getBusinessConnection",
]);

/** Read-only methods that legitimately carry business_connection_id. */
const BUSINESS_READ_METHODS = new Set(["getBusinessConnection"]);

/**
 * Proof that the callback presser was checked against OWNER_TELEGRAM_ID.
 * A module-private symbol, so it cannot be forged by a plain object key (and is
 * never serialised into the HTTP body: JSON.stringify skips symbol keys).
 */
export const OWNER_VERIFIED: unique symbol = Symbol("shadow.ownerVerified");

export interface GuardDecision {
  allowed: boolean;
  reason: string;
}

export function effectiveFlags() {
  const req = config().flagsRequested;
  return {
    requested: req,
    effective: SHADOW_MODE_V1_LOCK
      ? { allowAutoreply: false, allowDelegation: false, allowPublish: false }
      : req,
  };
}

/** Strict chat id parsing: a safe integer, or a string of digits. Anything else (arrays, "@channel", " 1e3", true) is rejected. */
function strictChatId(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v === "string" && /^-?\d{1,16}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function checkOutbound(method: string, params: Record<string, unknown>): GuardDecision {
  const ownerId = config().telegram.ownerId;

  if ("business_connection_id" in params && params.business_connection_id != null && !BUSINESS_READ_METHODS.has(method)) {
    return { allowed: false, reason: "business_connection_id present — replying on owner's behalf is disabled in V1" };
  }

  if (NON_DELIVERY_METHODS.has(method)) {
    if (method === "answerCallbackQuery") {
      if ((params as Record<PropertyKey, unknown>)[OWNER_VERIFIED] !== true) {
        return { allowed: false, reason: "callback presser not verified as owner" };
      }
      if (params.url != null) return { allowed: false, reason: "answerCallbackQuery url is not allowed" };
    }
    return { allowed: true, reason: "non-delivery method" };
  }

  if (OWNER_ONLY_SEND_METHODS.has(method)) {
    const chatId = strictChatId(params.chat_id);
    if (chatId === null || chatId !== ownerId) {
      return { allowed: false, reason: "chat_id is not OWNER_TELEGRAM_ID" };
    }
    return { allowed: true, reason: "owner private chat" };
  }

  // Everything else (sendPhoto to others, forwardMessage, editMessageText,
  // deleteMessage, readBusinessMessage, copyMessage, postStory, setWebhook, …) is denied.
  return { allowed: false, reason: `method ${method} is not on the V1 allow-list` };
}
