import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import { db, schema, type DB } from "../db/client.js";

/**
 * CONFIDENCE SYSTEM for learnings about Abdulloh.
 *
 *  1 supporting evidence        → HYPOTHESIS
 *  2–4 consistent evidence      → LIKELY
 *  5+ consistent evidence       → STABLE (candidate)
 *  contradictions lower consistency → confidence drops / status falls back
 *  owner confirmed ("Ha, aynan shu") → STABLE + confirmed_by_owner, beats AI guesses
 *  owner rejected                → REJECTED
 */
export type PrefStatus = "HYPOTHESIS" | "LIKELY" | "STABLE" | "REJECTED";

export function computePreferenceState(p: {
  supporting: number;
  contradicting: number;
  confirmed: boolean;
  rejected: boolean;
}): { confidence: number; status: PrefStatus } {
  const s = Math.max(0, p.supporting);
  const c = Math.max(0, p.contradicting);
  if (p.rejected) return { confidence: 0.05, status: "REJECTED" };
  if (p.confirmed) return { confidence: c > s ? 0.8 : 0.95, status: "STABLE" };
  if (s === 0) return { confidence: c >= 2 ? 0.05 : 0.1, status: c >= 2 ? "REJECTED" : "HYPOTHESIS" };
  const consistency = s / (s + c);
  const confidence = Math.min(0.9, (1 - Math.exp(-s / 2.5)) * consistency);
  let status: PrefStatus = "HYPOTHESIS";
  if (s >= 5 && consistency >= 0.8) status = "STABLE";
  else if (s >= 2 && consistency >= 0.67) status = "LIKELY";
  else if (c >= 2 && consistency < 0.34) status = "REJECTED";
  return { confidence: Math.round(confidence * 1000) / 1000, status };
}

export function confidenceLabel(c: number): "LOW" | "MEDIUM" | "HIGH" {
  return c >= 0.7 ? "HIGH" : c >= 0.4 ? "MEDIUM" : "LOW";
}

export async function recomputePreference(id: number, x: DB = db()): Promise<void> {
  const [agg] = await x
    .select({
      supporting: sql<number>`coalesce(sum(case when ${schema.learningEvidence.polarity}='SUPPORTS' then ${schema.learningEvidence.weight} else 0 end),0)::float8`,
      contradicting: sql<number>`coalesce(sum(case when ${schema.learningEvidence.polarity}='CONTRADICTS' then ${schema.learningEvidence.weight} else 0 end),0)::float8`,
      count: sql<number>`count(*)::int`,
      last: sql<Date | null>`max(${schema.learningEvidence.createdAt})`,
    })
    .from(schema.learningEvidence)
    .where(and(eq(schema.learningEvidence.preferenceId, id), eq(schema.learningEvidence.active, true)));
  const [pref] = await x.select().from(schema.preferences).where(eq(schema.preferences.id, id));
  if (!pref) return;
  const st = computePreferenceState({
    supporting: agg.supporting,
    contradicting: agg.contradicting,
    confirmed: pref.confirmedByOwner,
    rejected: pref.rejectedByOwner,
  });
  await x
    .update(schema.preferences)
    .set({
      supportingCount: agg.supporting,
      contradictingCount: agg.contradicting,
      evidenceCount: agg.count,
      confidence: st.confidence,
      status: st.status,
      lastEvidenceAt: agg.last ? new Date(agg.last) : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.preferences.id, id));
}

function norm(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface EvidenceInput {
  preferenceId?: number | null;
  create?: { scope: string; projectId: number | null; personId?: number | null; statement: string; rationale?: string | null; pendingProjectBatchId?: number | null };
  polarity: "SUPPORTS" | "CONTRADICTS";
  messageIds: number[];
  source: "CHAT" | "OWNER_ANSWER" | "OWNER_STATEMENT";
  feedbackEventId?: number | null;
  learningQuestionId?: number | null;
  note?: string | null;
  weight?: number;
  confirm?: boolean;
  reject?: boolean;
}

/** Adds one piece of evidence (creating the preference if needed) and recomputes confidence. Returns preference id. */
export async function addEvidence(e: EvidenceInput, x: DB = db()): Promise<number | null> {
  let prefId = e.preferenceId ?? null;
  if (prefId) {
    const [exists] = await x.select({ id: schema.preferences.id }).from(schema.preferences).where(eq(schema.preferences.id, prefId));
    if (!exists) prefId = null;
  }
  if (!prefId && e.create) {
    // Same statement in the same scope/project counts as support, not a duplicate row.
    const candidates = await x
      .select()
      .from(schema.preferences)
      .where(
        and(
          eq(schema.preferences.scope, e.create.scope),
          e.create.projectId == null ? isNull(schema.preferences.projectId) : eq(schema.preferences.projectId, e.create.projectId),
        ),
      );
    const same = candidates.find((c) => norm(c.statement) === norm(e.create!.statement));
    if (same) prefId = same.id;
    else {
      const [row] = await x
        .insert(schema.preferences)
        .values({
          scope: e.create.scope,
          projectId: e.create.projectId,
          personId: e.create.personId ?? null,
          statement: e.create.statement,
          rationale: e.create.rationale ?? null,
          pendingProjectBatchId: e.create.pendingProjectBatchId ?? null,
        })
        .returning({ id: schema.preferences.id });
      prefId = row.id;
    }
  }
  if (!prefId) return null;

  await x.insert(schema.learningEvidence).values({
    preferenceId: prefId,
    messageIds: e.messageIds,
    feedbackEventId: e.feedbackEventId ?? null,
    learningQuestionId: e.learningQuestionId ?? null,
    polarity: e.polarity,
    weight: e.weight ?? 1,
    source: e.source,
    note: e.note ?? null,
  });
  if (e.confirm) await x.update(schema.preferences).set({ confirmedByOwner: true, rejectedByOwner: false }).where(eq(schema.preferences.id, prefId));
  if (e.reject) await x.update(schema.preferences).set({ rejectedByOwner: true, confirmedByOwner: false }).where(eq(schema.preferences.id, prefId));
  await recomputePreference(prefId, x);
  return prefId;
}

export async function setOwnerVerdict(prefId: number, verdict: "CONFIRM" | "REJECT", questionId?: number | null): Promise<boolean> {
  const [p] = await db().select().from(schema.preferences).where(eq(schema.preferences.id, prefId));
  if (!p) return false;
  await addEvidence({
    preferenceId: prefId,
    polarity: verdict === "CONFIRM" ? "SUPPORTS" : "CONTRADICTS",
    messageIds: [],
    source: "OWNER_ANSWER",
    learningQuestionId: questionId ?? null,
    confirm: verdict === "CONFIRM",
    reject: verdict === "REJECT",
  });
  return true;
}

/**
 * Deleted messages: evidence that relied on them is deactivated and affected
 * preferences recomputed; tasks sourced from them lose confidence.
 */
export async function onMessagesDeleted(messageIds: number[]): Promise<void> {
  if (!messageIds.length) return;
  const d = db();
  const arr = sql`ARRAY[${sql.join(messageIds.map((i) => sql`${i}`), sql`, `)}]::int[]`;
  const affected = await d
    .update(schema.learningEvidence)
    .set({ active: false })
    .where(and(eq(schema.learningEvidence.active, true), sql`${schema.learningEvidence.messageIds} && ${arr}`))
    .returning({ preferenceId: schema.learningEvidence.preferenceId });
  const ids = [...new Set(affected.map((a) => a.preferenceId).filter((v): v is number => v != null))];
  for (const id of ids) await recomputePreference(id);

  await d
    .update(schema.tasks)
    .set({ confidence: sql`${schema.tasks.confidence} * 0.5`, staleEvidence: true, updatedAt: new Date() })
    .where(inArray(schema.tasks.sourceMessageId, messageIds));
}
