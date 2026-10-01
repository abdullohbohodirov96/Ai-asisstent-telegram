import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { enqueueUpdate, processPendingUpdates, recoverStuckUpdates } from "../src/telegram/ingest.js";
import { scrub } from "../src/util/log.js";
import { formBatches } from "../src/engine/batcher.js";
import { buildServer } from "../src/server.js";
import { resetDb, installFakeTelegram, installFakeAI, wire, businessMessage, businessConnection, ownerMessage, tash, sent, OWNER, emptyAnalysis } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  installFakeAI(() => emptyAnalysis());
  wire();
});

describe("Telegram ingest", () => {
  it("ignores duplicate Telegram updates (idempotent on update_id and message id)", async () => {
    const u = businessMessage({ id: 1, text: "Salom", date: tash("2026-09-29T10:00:00") });
    expect(await enqueueUpdate(u)).toBe(true);
    expect(await enqueueUpdate(u)).toBe(false);
    await processPendingUpdates();
    await processPendingUpdates();
    // same message delivered again under a different update id
    await enqueueUpdate({ ...u, update_id: u.update_id + 10_000 });
    await processPendingUpdates();
    const msgs = await db().select().from(schema.messages);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe("INCOMING");
    expect(msgs[0].analysisStatus).toBe("PENDING");
  });

  it("groups messages into 5-minute chat windows and never batches an open window", async () => {
    await enqueueUpdate(businessConnection());
    await enqueueUpdate(businessMessage({ id: 1, text: "a", date: tash("2026-09-29T10:00:10") }));
    await enqueueUpdate(businessMessage({ id: 2, from: OWNER, text: "b", date: tash("2026-09-29T10:03:00") }));
    await enqueueUpdate(businessMessage({ id: 3, text: "c", date: tash("2026-09-29T10:06:00") }));
    await enqueueUpdate(businessMessage({ id: 4, text: "other chat", date: tash("2026-09-29T10:01:00"), chatWith: 3001 }));
    await processPendingUpdates();

    expect(await formBatches(tash("2026-09-29T10:04:00"))).toHaveLength(0); // window 10:00-10:05 still open
    const ids = await formBatches(tash("2026-09-29T10:12:00"));
    expect(ids).toHaveLength(3); // bobur 10:00, bobur 10:05, ali 10:00
    const batches = await db().select().from(schema.messageBatches);
    const msgs = await db().select().from(schema.messages);
    const byBatch = new Map<number, number>();
    for (const m of msgs) byBatch.set(m.batchId!, (byBatch.get(m.batchId!) ?? 0) + 1);
    expect([...byBatch.values()].sort()).toEqual([1, 1, 2]);
    expect(batches.every((b) => b.windowEnd.getTime() - b.windowStart.getTime() === 5 * 60_000)).toBe(true);
    // re-running does not create new batches
    expect(await formBatches(tash("2026-09-29T10:20:00"))).toHaveLength(0);
  });

  it("stores edits with an audit version and soft-deletes deletions", async () => {
    await enqueueUpdate(businessMessage({ id: 7, text: "eski", date: tash("2026-09-29T10:00:00") }));
    await processPendingUpdates();
    await enqueueUpdate({
      update_id: 90001,
      edited_business_message: { message_id: 7, business_connection_id: "conn-1", date: 0, edit_date: 1_790_000_000, chat: { id: 2001, type: "private" }, from: { id: 2001, first_name: "Bobur" }, text: "yangi" },
    });
    await enqueueUpdate({ update_id: 90002, deleted_business_messages: { business_connection_id: "conn-1", chat: { id: 2001, type: "private" }, message_ids: [7] } });
    await processPendingUpdates();
    const [m] = await db().select().from(schema.messages);
    expect(m.text).toBe("yangi");
    expect(m.editedAt).not.toBeNull();
    expect(m.deletedAt).not.toBeNull(); // never hard-deleted
    const versions = await db().select().from(schema.messageVersions).where(eq(schema.messageVersions.messageId, m.id));
    expect(versions[0].text).toBe("eski");
  });

  it("ignores business messages from a connection that belongs to someone else", async () => {
    await enqueueUpdate({ update_id: 777, business_connection: { id: "conn-x", user: { id: 5555 }, is_enabled: true } });
    await enqueueUpdate({ ...businessMessage({ id: 1, text: "x", date: new Date() }), update_id: 778, business_message: { ...businessMessage({ id: 1, text: "x", date: new Date() }).business_message, business_connection_id: "conn-x" } });
    await processPendingUpdates();
    expect(await db().select().from(schema.messages)).toHaveLength(0);
  });

  it("webhook checks the secret, stores the update and returns 200 quickly with no Bot API payload", async () => {
    const app = buildServer();
    const bad = await app.inject({ method: "POST", url: "/telegram/webhook", payload: businessMessage({ id: 1, date: new Date() }) });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "hook-secret" },
      payload: businessMessage({ id: 2, date: new Date() }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(await db().select().from(schema.telegramUpdates)).toHaveLength(1);
    const cron = await app.inject({ method: "POST", url: "/internal/cron/analyze" });
    expect(cron.statusCode).toBe(401);
    const cronOk = await app.inject({ method: "POST", url: "/internal/cron/analyze", headers: { authorization: "Bearer cron-secret" } });
    expect(cronOk.statusCode).toBe(200);
    expect(sent.every((s) => s.params.chat_id === undefined || s.params.chat_id === OWNER)).toBe(true);
    await app.close();
  });

  it("stuck-update recovery is based on the claim time, not on when the update was received", async () => {
    await enqueueUpdate(businessMessage({ id: 1, date: new Date() }));
    const old = new Date(Date.now() - 60 * 60_000);
    // a retry of an hour-old update that was claimed just now must not be reset (double processing)
    await db().update(schema.telegramUpdates).set({ status: "PROCESSING", receivedAt: old, lockedAt: new Date() });
    await recoverStuckUpdates();
    expect((await db().select().from(schema.telegramUpdates))[0].status).toBe("PROCESSING");
    // a claim older than 10 minutes is a crashed run → back to the queue
    await db().update(schema.telegramUpdates).set({ lockedAt: new Date(Date.now() - 11 * 60_000) });
    await recoverStuckUpdates();
    expect((await db().select().from(schema.telegramUpdates))[0].status).toBe("PENDING");
  });

  it("owner messages are handled at most once, even if the update is retried", async () => {
    installFakeAI(() => ({ reply_text: "Bajarildi", actions: [{ type: "CREATE_TASK", title: "Qo'ng'iroq", details: null, due_iso: null, owner_name: null, project_name: null, task_id: null, preference_id: null, scope: null }] }));
    await enqueueUpdate(ownerMessage({ id: 7, text: "Boburga qo'ng'iroqni eslat" }));
    await processPendingUpdates();
    const before = sent.filter((x) => x.method === "sendMessage").length;
    expect(await db().select().from(schema.tasks)).toHaveLength(1);
    // simulate a retry (e.g. a crash after the handler ran but before the update was marked DONE)
    await db().update(schema.telegramUpdates).set({ status: "PENDING" });
    await processPendingUpdates();
    expect(sent.filter((x) => x.method === "sendMessage").length).toBe(before);
    expect(await db().select().from(schema.tasks)).toHaveLength(1);
  });

  it("logs never contain bound query params (private message text)", () => {
    const e = Object.assign(new Error('Failed query: insert into "as_messages" ("text") values ($1)\nparams: Salom, bu maxfiy xabar'), {
      query: 'insert into "as_messages" ("text") values ($1)',
      params: ["Salom, bu maxfiy xabar"],
      cause: new Error("connection terminated"),
    });
    const out = scrub(e);
    expect(out).not.toContain("maxfiy");
    expect(out).toContain("connection terminated");
    expect(scrub("Failed query: x\nparams: maxfiy")).not.toContain("maxfiy");
  });
});
