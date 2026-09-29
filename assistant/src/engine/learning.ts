import { desc, eq, gte, notInArray } from "drizzle-orm";
import { config } from "../config/env.js";
import { db, schema } from "../db/client.js";
import { generateStructured } from "../ai/client.js";
import { LEARNING_SYSTEM, ProfileUpdateSchema, buildLearningPrompt } from "../ai/prompts/learning.js";

/**
 * ABDULLOH LEARNING ENGINE — profile consolidation.
 * Raw learning lives in preferences + learning_evidence + feedback_events.
 * Once a day (before the evening review) it is condensed into the owner's
 * style/taste profiles, keeping GLOBAL and per-project tastes separate.
 */
export async function refreshProfiles(now = new Date()): Promise<boolean> {
  const d = db();
  const prefs = await d.select().from(schema.preferences).where(notInArray(schema.preferences.status, ["REJECTED"])).orderBy(desc(schema.preferences.confidence)).limit(80);
  if (!prefs.length) return false;
  const projects = await d.select().from(schema.projects);
  const feedback = await d
    .select()
    .from(schema.feedbackEvents)
    .where(gte(schema.feedbackEvents.createdAt, new Date(now.getTime() - 14 * 86400_000)))
    .orderBy(desc(schema.feedbackEvents.createdAt))
    .limit(40);
  const pn = new Map(projects.map((p) => [p.id, p.name]));
  const payload = {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    preferences: prefs.map((p) => ({
      scope: p.scope,
      project_id: p.projectId,
      project: p.projectId ? pn.get(p.projectId) : null,
      statement: p.statement,
      status: p.status,
      confidence: p.confidence,
      evidence_count: p.evidenceCount,
      contradictions: p.contradictingCount,
      confirmed_by_owner: p.confirmedByOwner,
    })),
    recent_feedback: feedback.map((f) => ({ kind: f.subjectKind, reaction: f.reaction, reason: f.explicitReason, hypothesis: f.inferredReason, project: f.projectId ? pn.get(f.projectId) : null })),
  };
  const { data } = await generateStructured({
    purpose: "LEARNING",
    tier: "DEEP",
    system: LEARNING_SYSTEM,
    user: buildLearningPrompt(JSON.stringify(payload)),
    schema: ProfileUpdateSchema,
  });
  const ownerId = config().telegram.ownerId;
  await d.insert(schema.userProfile).values({ telegramUserId: ownerId, name: "Abdulloh" }).onConflictDoNothing();
  const projectTastes: Record<string, string> = {};
  for (const t of data.project_tastes) if (pn.has(t.project_id)) projectTastes[String(t.project_id)] = t.taste;
  await d
    .update(schema.userProfile)
    .set({
      communicationStyle: data.communication_style,
      managementStyle: data.management_style,
      delegationStyle: data.delegation_style,
      decisionStyle: data.decision_style,
      creativeTaste: data.creative_taste,
      scenarioTaste: data.scenario_taste,
      designTaste: data.design_taste,
      videoTaste: data.video_taste,
      projectTastes,
      updatedAt: new Date(),
    })
    .where(eq(schema.userProfile.telegramUserId, ownerId));
  return true;
}
