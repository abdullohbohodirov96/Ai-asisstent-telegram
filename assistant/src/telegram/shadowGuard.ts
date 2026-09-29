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

/** Methods that do not deliver content to any chat. */
const NON_DELIVERY_METHODS = new Set([
  "getMe",
  "getFile",
  "getWebhookInfo",
  "setWebhook",
  "deleteWebhook",
  "setMyCommands",
  "answerCallbackQuery", // only shows a toast to the button presser; caller must verify presser == owner
  "getBusinessConnection",
]);

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

export function checkOutbound(method: string, params: Record<string, unknown>): GuardDecision {
  const ownerId = config().telegram.ownerId;

  if ("business_connection_id" in params && params.business_connection_id != null) {
    return { allowed: false, reason: "business_connection_id present — replying on owner's behalf is disabled in V1" };
  }

  if (NON_DELIVERY_METHODS.has(method)) {
    if (method === "answerCallbackQuery" && params.__ownerVerified !== true) {
      return { allowed: false, reason: "callback presser not verified as owner" };
    }
    return { allowed: true, reason: "non-delivery method" };
  }

  if (OWNER_ONLY_SEND_METHODS.has(method)) {
    const chatId = Number(params.chat_id);
    if (!Number.isFinite(chatId) || chatId !== ownerId) {
      return { allowed: false, reason: "chat_id is not OWNER_TELEGRAM_ID" };
    }
    return { allowed: true, reason: "owner private chat" };
  }

  // Everything else (sendPhoto to others, forwardMessage, editMessageText,
  // deleteMessage, readBusinessMessage, copyMessage, postStory, …) is denied.
  return { allowed: false, reason: `method ${method} is not on the V1 allow-list` };
}
