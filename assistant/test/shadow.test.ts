import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { callTelegram, sendToOwner } from "../src/telegram/api.js";
import { checkOutbound, effectiveFlags, ShadowModeViolation } from "../src/telegram/shadowGuard.js";
import { enqueueUpdate, processPendingUpdates } from "../src/telegram/ingest.js";
import { formBatches } from "../src/engine/batcher.js";
import { analyzePendingBatches } from "../src/engine/analyzer.js";
import { config } from "../src/config/env.js";
import { resetDb, installFakeTelegram, installFakeAI, wire, businessMessage, ownerMessage, callback, sent, ownerTexts, emptyAnalysis, OWNER, BOBUR, tash } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  wire();
});

describe("Shadow Mode outbound blocking", () => {
  it("blocks any call carrying business_connection_id, even to the owner", async () => {
    expect(checkOutbound("sendMessage", { chat_id: OWNER, business_connection_id: "c" }).allowed).toBe(false);
    await expect(callTelegram("sendMessage", { chat_id: BOBUR, text: "hi", business_connection_id: "conn-1" })).rejects.toBeInstanceOf(ShadowModeViolation);
    expect(sent).toHaveLength(0);
    const audit = await db().select().from(schema.outboundAudit).where(eq(schema.outboundAudit.allowed, false));
    expect(audit).toHaveLength(1);
  });

  it("blocks messages to anyone but OWNER_TELEGRAM_ID and non-allow-listed methods", async () => {
    await expect(callTelegram("sendMessage", { chat_id: BOBUR, text: "vazifa" })).rejects.toThrow(/Shadow Mode/);
    await expect(callTelegram("sendMessage", { chat_id: -100123, text: "post" })).rejects.toThrow(/Shadow Mode/);
    for (const m of ["forwardMessage", "copyMessage", "editMessageText", "deleteMessage", "sendPhoto", "readBusinessMessage", "postStory"]) {
      await expect(callTelegram(m, { chat_id: OWNER })).rejects.toBeInstanceOf(ShadowModeViolation);
    }
    await expect(callTelegram("answerCallbackQuery", { callback_query_id: "x" })).rejects.toBeInstanceOf(ShadowModeViolation);
    expect(sent).toHaveLength(0);
    await sendToOwner("ok");
    expect(sent).toHaveLength(1);
    expect(sent[0].params.chat_id).toBe(OWNER);
  });

  it("keeps ALLOW_* flags effectively off in V1 even if env enables them", () => {
    const c = config();
    const saved = { ...c.flagsRequested };
    c.flagsRequested.allowAutoreply = true;
    c.flagsRequested.allowDelegation = true;
    c.flagsRequested.allowPublish = true;
    const f = effectiveFlags();
    expect(f.effective).toEqual({ allowAutoreply: false, allowDelegation: false, allowPublish: false });
    Object.assign(c.flagsRequested, saved);
  });

  it("full business-chat pipeline never sends anything to a non-owner even when AI says a reply is needed", async () => {
    installFakeAI(() =>
      emptyAnalysis({
        importance: 0.9,
        unanswered_important: [{ message_id: 1, why: "narx so'rayapti", urgency: "HIGH" }],
        next_actions: [{ action: "Boburga javob yozing", for_owner: true }],
        tasks: [{ title: "Video", description: null, owner: "COUNTERPART", assigned_by: "OWNER", deadline_iso: null, remind_at_iso: null, priority: "HIGH", status: "TODO", existing_task_id: null, confidence: 0.9, evidence_message_ids: [1] }],
      }),
    );
    await enqueueUpdate(businessMessage({ id: 1, text: "Narxi qancha? Tezroq javob bering", date: tash("2026-09-29T10:00:00") }));
    await processPendingUpdates();
    await formBatches(tash("2026-09-29T10:10:00"));
    await analyzePendingBatches();
    expect(sent.length).toBeGreaterThanOrEqual(0);
    for (const s of sent) {
      expect(s.params.business_connection_id).toBeUndefined();
      if (s.method === "sendMessage") expect(s.params.chat_id).toBe(OWNER);
    }
  });

  it("OWNER authorization: non-owner messages, commands and callbacks are silently ignored", async () => {
    installFakeAI(() => ({ reply_text: "x", actions: [] }));
    await enqueueUpdate(ownerMessage({ id: 1, text: "/tasks", from: 4242 }));
    await enqueueUpdate(ownerMessage({ id: 2, text: "salom bot", from: 4242 }));
    await enqueueUpdate(callback("q:1:0", 4242));
    await processPendingUpdates();
    expect(sent).toHaveLength(0);
    const ups = await db().select().from(schema.telegramUpdates);
    expect(ups.every((u) => u.status === "IGNORED")).toBe(true);

    await enqueueUpdate(ownerMessage({ id: 3, text: "/shadow" }));
    await processPendingUpdates();
    expect(ownerTexts()[0]).toContain("SHADOW MODE V1");
    expect(sent[0].params.chat_id).toBe(OWNER);
  });
});
