import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "../src/db/client.js";
import { enqueueUpdate } from "../src/telegram/ingest.js";
import { tick } from "../src/jobs/worker.js";
import { runSlot } from "../src/reports/service.js";
import { resetDb, installFakeTelegram, installFakeAI, wire, businessMessage, businessConnection, ownerMessage, emptyAnalysis, sent, ownerTexts, OWNER, tash } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
  installFakeTelegram();
  wire();
});

/**
 * DONE DEFINITION flow:
 * business message → Neon → 5-min batch → structured analysis → person/project/task/feedback saved
 * → learning question → owner answers (vague) → focused follow-up → owner answers → resolved
 * → preference confidence updated → report uses the data → AIUsage written → nobody else messaged.
 */
describe("End-to-end Shadow Mode V1 flow", () => {
  it("runs the complete learning loop without messaging anyone but the owner", async () => {
    const [proj] = await db().insert(schema.projects).values({ name: "Al-Bayan", aliases: ["Albayan", "markaz"] }).returning();
    let evalCalls = 0;
    const reportPrompts: string[] = [];
    installFakeAI((req) => {
      switch (req.purpose) {
        case "BATCH_ANALYSIS":
          return emptyAnalysis({
            summary: "Bobur Al-Bayan ssenariysini yubordi, Abdulloh rad etdi va ertaga yangi video so'radi",
            importance: 0.8,
            project: { existing_project_id: proj.id, name_mentioned: "Albayan", confidence: 0.9, needs_clarification: false, is_new_project_candidate: false, evidence_message_ids: [1] },
            people: [{ ref: "COUNTERPART", telegram_user_id: 2001, role_guess: "ssenarist", role_confidence: 0.5, company: null, evidence_message_ids: [1] }],
            tasks: [{ title: "Yangi ssenariy va video", description: null, owner: "COUNTERPART", assigned_by: "OWNER", deadline_iso: "2026-09-30T18:00:00+05:00", remind_at_iso: null, priority: "HIGH", status: "TODO", existing_task_id: null, confidence: 0.85, evidence_message_ids: [3] }],
            commitments: [{ who: "COUNTERPART", to_whom: "OWNER", what: "Ertaga yangi variant", due_iso: "2026-09-30T18:00:00+05:00", confidence: 0.8, evidence_message_ids: [4] }],
            creative_submissions: [{ kind: "SCENARIO", description: "Al-Bayan ssenariy v1", submitted_by: "COUNTERPART", message_id: 1, confidence: 0.9 }],
            owner_feedback: [{ submission_index: 0, subject_kind: "SCENARIO", reaction: "REJECT", explicit_reason: null, inferred_reason: "generic bo'lishi mumkin", confidence: 0.6, evidence_message_ids: [2] }],
            preference_evidence: [{ scope: "SCENARIO", project_scoped: true, matches_preference_id: null, polarity: "NEW", statement: "Al-Bayan ssenariysi oddiy/generic bo'lmasligi kerak (taxmin)", is_explicit: false, confidence: 0.4, evidence_message_ids: [2] }],
            clarification_questions: [{ kind: "FEEDBACK_REASON", question: "Al-Bayan ssenariysini rad qildingiz. Aynan nimasi yoqmadi?", importance: 0.9, related_task_index: null, related_feedback_index: 0, related_person_ref: null, evidence_message_ids: [2] }],
            person_summary_update: "Bobur — Al-Bayan uchun ssenariy yozadi (taxmin).",
          });
        case "QUESTION_EVALUATION":
          evalCalls++;
          if (evalCalls === 1)
            return { is_answer: true, sufficient: false, answer_summary: null, project_name: null, yes_no: null, role: null, learned: [], follow_up_question: "Tushundim. Ko'proq qaysi tomoni: hook, syujet, juda reklamaviyligi yoki dialog?", acknowledgement: "" };
          return {
            is_answer: true,
            sufficient: true,
            answer_summary: "Juda reklamaviy; real ustoz bilan boshlanishi kerak",
            project_name: null,
            yes_no: null,
            role: null,
            learned: [{ scope: "SCENARIO", project_scoped: true, statement: "Al-Bayan ssenariysi reklamaviy bo'lmasin, real ustoz bilan boshlansin", confirms_preference_id: null, rejects_preference_id: null }],
            follow_up_question: null,
            acknowledgement: "Tushundim, saqladim.",
          };
        case "REPORT":
          reportPrompts.push(req.user);
          return "🧠 QISQA HOLAT\n• Bobur ertaga yangi ssenariy yuboradi.\n\n➡️ KEYINGI ENG TO'G'RI 3 ACTION\n1. x\n2. y\n3. z";
        case "LEARNING":
          return { communication_style: null, management_style: null, delegation_style: null, decision_style: null, creative_taste: null, scenario_taste: "[tasdiqlangan] real ustoz bilan boshlanish", design_taste: null, video_taste: null, project_tastes: [{ project_id: proj.id, taste: "reklamaviy emas, tabiiy" }] };
        default:
          return new Error("unexpected purpose " + req.purpose);
      }
    });

    // 1) Telegram Business chat → DB
    await enqueueUpdate(businessConnection());
    await enqueueUpdate(businessMessage({ id: 1, text: "Albayan uchun ssenariy: 'Eng yaxshi markaz! Hoziroq yoziling!'", date: tash("2026-09-29T10:00:00") }));
    await enqueueUpdate(businessMessage({ id: 2, from: OWNER, text: "Bunaqa bo'midi, juda oddiy.", date: tash("2026-09-29T10:01:00") }));
    await enqueueUpdate(businessMessage({ id: 3, from: OWNER, text: "Ertaga yangisini va videoni tayyorla.", date: tash("2026-09-29T10:02:00") }));
    await enqueueUpdate(businessMessage({ id: 4, text: "Xo'p, ertaga yuboraman", date: tash("2026-09-29T10:03:00") }));

    // 2) worker tick: ingest → batch → analysis → question
    const t = await tick({ now: tash("2026-09-29T10:06:00") });
    expect(t.errors).toEqual([]);
    expect(t.batchesFormed).toBe(1);
    expect(t.batchesAnalysed).toBe(1);

    const [task] = await db().select().from(schema.tasks);
    expect(task.projectId).toBe(proj.id);
    const [bobur] = await db().select().from(schema.persons).where((await import("drizzle-orm")).eq(schema.persons.telegramUserId, 2001));
    expect(task.ownerPersonId).toBe(bobur.id);
    expect(bobur.role).toBe("ssenarist");
    expect(bobur.roleConfirmed).toBe(false);
    expect(await db().select().from(schema.commitments)).toHaveLength(1);
    let [pref] = await db().select().from(schema.preferences);
    expect(pref.status).toBe("HYPOTHESIS");
    expect(pref.projectId).toBe(proj.id);

    const question = ownerTexts().find((x) => x.includes("Aynan nimasi yoqmadi"));
    expect(question).toBeTruthy();

    // 3) owner answers vaguely → one focused follow-up
    await enqueueUpdate(ownerMessage({ id: 100, text: "prosto yoqmadi", date: tash("2026-09-29T10:09:00") }));
    await tick({ now: tash("2026-09-29T10:10:00") });
    expect(ownerTexts().at(-1)).toContain("hook, syujet");

    // 4) owner answers concretely → resolved + owner-confirmed learning
    await enqueueUpdate(ownerMessage({ id: 101, text: "Juda reklamaga o'xshab ketgan, real ustoz bilan boshlanishi kerak", date: tash("2026-09-29T10:11:00") }));
    await tick({ now: tash("2026-09-29T10:12:00") });
    const [q] = await db().select().from(schema.learningQuestions);
    expect(q.status).toBe("RESOLVED");
    expect(q.followUpCount).toBe(1);
    const prefs = await db().select().from(schema.preferences);
    const confirmed = prefs.find((p) => p.confirmedByOwner);
    expect(confirmed?.status).toBe("STABLE");
    expect(confirmed?.projectId).toBe(proj.id);

    // 5) evening report uses the data
    expect(await runSlot("2026-09-29", "EVENING", "cron", tash("2026-09-29T18:00:30"))).toBe("SENT");
    const data = JSON.parse(reportPrompts.at(-1)!.split("DATA:\n")[1]);
    expect(data.delegated_tasks.some((x: any) => x.title === "Yangi ssenariy va video")).toBe(true);
    expect(data.commitments).toHaveLength(1);
    expect(data.creative.owner_feedback[0].reason).toContain("reklamaviy");
    expect(data.learnings.some((l: any) => l.confirmed_by_owner)).toBe(true);
    const [profile] = await db().select().from(schema.userProfile);
    expect((profile.projectTastes as Record<string, string>)[String(proj.id)]).toContain("tabiiy");

    // 6) AI usage recorded for every purpose used
    const usage = await db().select().from(schema.aiUsage);
    expect(new Set(usage.map((u) => u.purpose))).toEqual(new Set(["BATCH_ANALYSIS", "QUESTION_EVALUATION", "REPORT", "LEARNING"]));
    expect(usage.every((u) => Number(u.estimatedCostUsd) > 0)).toBe(true);

    // 7) Shadow Mode: nothing was sent to anyone but the owner
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      // the only call allowed to carry it is the read-only ownership check
      if (s.method !== "getBusinessConnection") expect(s.params.business_connection_id).toBeUndefined();
      if (s.method === "sendMessage") expect(s.params.chat_id).toBe(OWNER);
    }
    const blocked = await db().select().from(schema.outboundAudit);
    expect(blocked.every((b) => b.allowed)).toBe(true);
  });
});
