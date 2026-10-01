import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { setTransport } from "../src/telegram/api.js";
import { setProvider } from "../src/ai/client.js";
import { registerOwnerHandler, registerDeletionListener } from "../src/telegram/ingest.js";
import { onOwnerMessage, onOwnerCallback } from "../src/bot/owner.js";
import { onMessagesDeleted } from "../src/engine/preferences.js";
import { setTranscriptionProvider } from "../src/transcription/provider.js";
import { setFileDownloader } from "../src/engine/files.js";
import type { AIProvider, AIRequest, AIResponse } from "../src/ai/provider.js";
import type { BatchAnalysis } from "../src/ai/prompts/batch-analysis.js";

export const OWNER = 1000;
export const BOBUR = 2001;
export const CONN = "conn-1";

let migrated = false;
export async function resetDb() {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  const res = await db().execute(sql`select tablename from pg_tables where schemaname='public' and tablename like 'as\\_%'`);
  const names = (res.rows as { tablename: string }[]).map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db().execute(sql.raw(`truncate ${names} restart identity cascade`));
}

export interface Sent {
  method: string;
  params: Record<string, any>;
}
export const sent: Sent[] = [];
let msgId = 50_000;
export function installFakeTelegram() {
  sent.length = 0;
  setTransport(async (method, params) => {
    sent.push({ method, params });
    if (method === "sendMessage") return { message_id: ++msgId };
    if (method === "getBusinessConnection") {
      // Unknown connections are verified with Telegram; CONN belongs to the owner, anything else to a stranger.
      const id = String(params.business_connection_id);
      return { id, user: { id: id === CONN ? OWNER : 9_999_999, first_name: "x" }, user_chat_id: id === CONN ? OWNER : 9_999_999, date: 0, is_enabled: true };
    }
    return true;
  });
}
export const ownerTexts = () => sent.filter((s) => s.method === "sendMessage").map((s) => String(s.params.text));

export type AIHandler = (req: AIRequest) => unknown;
export class FakeAI implements AIProvider {
  readonly name = "fake";
  calls: AIRequest[] = [];
  constructor(public handler: AIHandler) {}
  modelFor(tier: string) {
    return tier === "DEEP" ? "test-deep" : "test-fast";
  }
  async generate(req: AIRequest): Promise<AIResponse> {
    this.calls.push(req);
    const out = await this.handler(req);
    if (out instanceof Error) throw out;
    return { text: typeof out === "string" ? out : JSON.stringify(out), model: this.modelFor(req.tier), inputTokens: 1000, outputTokens: 200 };
  }
}

export function installFakeAI(handler: AIHandler): FakeAI {
  const ai = new FakeAI(handler);
  setProvider(ai);
  return ai;
}

export function wire() {
  registerOwnerHandler({ onOwnerMessage, onOwnerCallback });
  registerDeletionListener(onMessagesDeleted);
  setTranscriptionProvider({ name: "fake", transcribe: async () => "Juda reklamaga o'xshab ketgan, real odam bilan boshlanishi kerak" });
  setFileDownloader(async () => ({ data: Buffer.from("ogg"), mimeType: "audio/ogg" }));
}

export function emptyAnalysis(over: Partial<BatchAnalysis> = {}): BatchAnalysis {
  return {
    summary: "suhbat",
    importance: 0.5,
    project: { existing_project_id: null, name_mentioned: null, confidence: 0, needs_clarification: false, is_new_project_candidate: false, evidence_message_ids: [] },
    people: [],
    tasks: [],
    commitments: [],
    decisions: [],
    waiting_items: [],
    followups: [],
    unanswered_important: [],
    creative_submissions: [],
    owner_feedback: [],
    preference_evidence: [],
    risks: [],
    next_actions: [],
    clarification_questions: [],
    person_summary_update: null,
    project_summary_update: null,
    ...over,
  };
}

let upd = 1;
export function businessMessage(opts: { id: number; from?: number; text?: string; date: Date; chatWith?: number; voice?: boolean; connection?: string }) {
  const chatWith = opts.chatWith ?? BOBUR;
  const from = opts.from ?? chatWith;
  return {
    update_id: upd++,
    business_message: {
      message_id: opts.id,
      business_connection_id: opts.connection ?? CONN,
      date: Math.floor(opts.date.getTime() / 1000),
      chat: { id: chatWith, type: "private", first_name: chatWith === BOBUR ? "Bobur" : "Ali" },
      from: from === OWNER ? { id: OWNER, first_name: "Abdulloh" } : { id: from, first_name: from === BOBUR ? "Bobur" : "Ali" },
      ...(opts.voice ? { voice: { file_id: "f1", duration: 3 } } : { text: opts.text ?? "salom" }),
    },
  };
}

export function ownerMessage(opts: { id: number; text?: string; voice?: boolean; replyTo?: number; from?: number; date?: Date }) {
  const from = opts.from ?? OWNER;
  return {
    update_id: upd++,
    message: {
      message_id: opts.id,
      date: Math.floor((opts.date ?? new Date()).getTime() / 1000),
      chat: { id: from, type: "private" },
      from: { id: from, first_name: from === OWNER ? "Abdulloh" : "Begona" },
      ...(opts.voice ? { voice: { file_id: "v1", duration: 4 } } : { text: opts.text ?? "" }),
      ...(opts.replyTo ? { reply_to_message: { message_id: opts.replyTo } } : {}),
    },
  };
}

export function callback(data: string, from = OWNER) {
  return { update_id: upd++, callback_query: { id: `cb${upd}`, from: { id: from }, data } };
}

export const businessConnection = () => ({
  update_id: upd++,
  business_connection: { id: CONN, user: { id: OWNER, first_name: "Abdulloh" }, user_chat_id: OWNER, date: 0, is_enabled: true, rights: { can_reply: false } },
});

/** Tashkent local time helper → Date. */
export function tash(iso: string): Date {
  return new Date(`${iso}+05:00`);
}
