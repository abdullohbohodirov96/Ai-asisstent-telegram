import {
  pgTable,
  serial,
  integer,
  bigint,
  text,
  boolean,
  real,
  numeric,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

/*
 * Neon PostgreSQL is the single source of truth. All tables are prefixed
 * `as_` (assistant) so they never collide with anything else in the database.
 *
 * Inferred (AI-produced) rows always carry `confidence` + `evidence_message_ids`
 * (internal messages.id values). AI guesses are never stored as facts.
 */

const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => tsz("created_at").notNull().defaultNow();
const updated = () => tsz("updated_at").notNull().defaultNow();
const tgId = (name: string) => bigint(name, { mode: "number" });
const evidence = () => integer("evidence_message_ids").array().notNull().default([]);

// ---------------------------------------------------------------- telegram plumbing

export const businessConnections = pgTable("as_business_connections", {
  id: text("id").primaryKey(), // telegram business_connection_id
  userId: tgId("user_id").notNull(),
  userChatId: tgId("user_chat_id"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  canReply: boolean("can_reply").notNull().default(false),
  rights: jsonb("rights"),
  updatedAt: updated(),
  createdAt: created(),
});

/** Raw update queue — idempotency key is Telegram's update_id. */
export const telegramUpdates = pgTable(
  "as_telegram_updates",
  {
    updateId: tgId("update_id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("PENDING"), // PENDING | PROCESSING | DONE | FAILED | IGNORED
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tsz("next_attempt_at").notNull().defaultNow(),
    error: text("error"),
    /** When the current PROCESSING claim was taken (stuck-claim recovery is based on this, not on received_at). */
    lockedAt: tsz("locked_at"),
    receivedAt: tsz("received_at").notNull().defaultNow(),
    processedAt: tsz("processed_at"),
  },
  (t) => [index("as_tg_updates_status_idx").on(t.status, t.nextAttemptAt)],
);

/** Every outbound Telegram call is audited (allowed or blocked). */
export const outboundAudit = pgTable("as_outbound_audit", {
  id: serial("id").primaryKey(),
  method: text("method").notNull(),
  chatId: tgId("chat_id"),
  allowed: boolean("allowed").notNull(),
  reason: text("reason"),
  createdAt: created(),
});

// ---------------------------------------------------------------- owner & people

export const userProfile = pgTable("as_user_profile", {
  id: serial("id").primaryKey(),
  telegramUserId: tgId("telegram_user_id").notNull().unique(),
  name: text("name"),
  communicationStyle: text("communication_style"),
  managementStyle: text("management_style"),
  delegationStyle: text("delegation_style"),
  decisionStyle: text("decision_style"),
  creativeTaste: text("creative_taste"),
  scenarioTaste: text("scenario_taste"),
  designTaste: text("design_taste"),
  videoTaste: text("video_taste"),
  /** { "<projectId>": "project-specific taste summary" } */
  projectTastes: jsonb("project_tastes").notNull().default({}),
  updatedAt: updated(),
});

export const persons = pgTable(
  "as_persons",
  {
    id: serial("id").primaryKey(),
    telegramUserId: tgId("telegram_user_id"),
    name: text("name").notNull(),
    username: text("username"),
    role: text("role"),
    roleConfidence: real("role_confidence").notNull().default(0),
    roleConfirmed: boolean("role_confirmed").notNull().default(false),
    company: text("company"),
    notes: text("notes"),
    /** Rolling memory summary. Hypotheses are marked "(taxmin)". */
    summary: text("summary"),
    confidence: real("confidence").notNull().default(1),
    isOwner: boolean("is_owner").notNull().default(false),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("as_persons_tg_uidx").on(t.telegramUserId)],
);

export const chats = pgTable(
  "as_chats",
  {
    id: serial("id").primaryKey(),
    telegramChatId: tgId("telegram_chat_id").notNull(),
    kind: text("kind").notNull(), // BUSINESS | ASSISTANT | OTHER
    businessConnectionId: text("business_connection_id"),
    title: text("title"),
    personId: integer("person_id").references(() => persons.id),
    defaultProjectId: integer("default_project_id"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("as_chats_kind_tg_uidx").on(t.kind, t.telegramChatId)],
);

export const messages = pgTable(
  "as_messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id").notNull().references(() => chats.id),
    telegramMessageId: tgId("telegram_message_id").notNull(),
    senderId: tgId("sender_id"),
    senderName: text("sender_name"),
    direction: text("direction").notNull(), // INCOMING | OUTGOING | OWNER_TO_ASSISTANT | ASSISTANT_TO_OWNER
    text: text("text"),
    transcript: text("transcript"),
    mediaType: text("media_type"),
    fileId: text("file_id"),
    replyToMessageId: tgId("reply_to_message_id"),
    businessConnectionId: text("business_connection_id"),
    sentAt: tsz("sent_at").notNull(),
    editedAt: tsz("edited_at"),
    deletedAt: tsz("deleted_at"),
    analysisStatus: text("analysis_status").notNull().default("PENDING"), // PENDING | PROCESSING | DONE | FAILED | SKIPPED
    batchId: integer("batch_id"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("as_messages_chat_tgmsg_uidx").on(t.chatId, t.telegramMessageId),
    index("as_messages_analysis_idx").on(t.analysisStatus, t.batchId),
    index("as_messages_sent_idx").on(t.sentAt),
  ],
);

export const messageVersions = pgTable("as_message_versions", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull().references(() => messages.id),
  text: text("text"),
  editedAt: tsz("edited_at"),
  recordedAt: created(),
});

// ---------------------------------------------------------------- projects & work

export const projects = pgTable("as_projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  aliases: text("aliases").array().notNull().default([]),
  description: text("description"),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | PAUSED | DONE | ARCHIVED
  goals: text("goals"),
  notes: text("notes"),
  summary: text("summary"),
  confirmedByOwner: boolean("confirmed_by_owner").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
});

export const projectMembers = pgTable(
  "as_project_members",
  {
    projectId: integer("project_id").notNull().references(() => projects.id),
    personId: integer("person_id").notNull().references(() => persons.id),
    role: text("role"),
    confidence: real("confidence").notNull().default(0.5),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] })],
);

export const messageBatches = pgTable(
  "as_message_batches",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id").notNull().references(() => chats.id),
    windowStart: tsz("window_start").notNull(),
    windowEnd: tsz("window_end").notNull(),
    seq: integer("seq").notNull().default(0),
    status: text("status").notNull().default("PENDING"), // PENDING | PROCESSING | DONE | FAILED
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tsz("next_attempt_at").notNull().defaultNow(),
    lockedAt: tsz("locked_at"),
    error: text("error"),
    projectId: integer("project_id"),
    createdAt: created(),
    completedAt: tsz("completed_at"),
  },
  (t) => [
    uniqueIndex("as_batches_chat_window_uidx").on(t.chatId, t.windowStart, t.seq),
    index("as_batches_status_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const analysisResults = pgTable("as_analysis_results", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().unique().references(() => messageBatches.id),
  model: text("model").notNull(),
  output: jsonb("output").notNull(),
  importance: real("importance").notNull().default(0),
  summary: text("summary"),
  createdAt: created(),
});

const inferred = () => ({
  confidence: real("confidence").notNull().default(0.5),
  evidenceMessageIds: evidence(),
  batchId: integer("batch_id"),
  chatId: integer("chat_id"),
});

export const tasks = pgTable(
  "as_tasks",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    projectId: integer("project_id").references(() => projects.id),
    ownerPersonId: integer("owner_person_id").references(() => persons.id),
    ownerNameText: text("owner_name_text"),
    assignedByPersonId: integer("assigned_by_person_id").references(() => persons.id),
    status: text("status").notNull().default("TODO"), // INBOX TODO IN_PROGRESS WAITING SUBMITTED REVISION DONE CANCELLED
    priority: text("priority").notNull().default("MEDIUM"), // LOW MEDIUM HIGH URGENT
    deadline: tsz("deadline"),
    remindAt: tsz("remind_at"),
    remindedAt: tsz("reminded_at"),
    sourceMessageId: integer("source_message_id"),
    needsClarification: boolean("needs_clarification").notNull().default(false),
    staleEvidence: boolean("stale_evidence").notNull().default(false),
    completedAt: tsz("completed_at"),
    ...inferred(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("as_tasks_status_idx").on(t.status)],
);

export const commitments = pgTable("as_commitments", {
  id: serial("id").primaryKey(),
  personId: integer("person_id").references(() => persons.id),
  whoText: text("who_text"),
  toPersonId: integer("to_person_id").references(() => persons.id),
  toText: text("to_text"),
  what: text("what").notNull(),
  promisedAt: tsz("promised_at"),
  dueAt: tsz("due_at"),
  status: text("status").notNull().default("OPEN"), // OPEN | DONE | BROKEN | CANCELLED
  projectId: integer("project_id").references(() => projects.id),
  ...inferred(),
  createdAt: created(),
  updatedAt: updated(),
});

export const decisions = pgTable("as_decisions", {
  id: serial("id").primaryKey(),
  what: text("what").notNull(),
  why: text("why"),
  projectId: integer("project_id").references(() => projects.id),
  decidedAt: tsz("decided_at"),
  ...inferred(),
  createdAt: created(),
});

export const waitingItems = pgTable("as_waiting_items", {
  id: serial("id").primaryKey(),
  direction: text("direction").notNull(), // OWNER_WAITS | WAITS_FOR_OWNER
  personId: integer("person_id").references(() => persons.id),
  personText: text("person_text"),
  what: text("what").notNull(),
  dueAt: tsz("due_at"),
  status: text("status").notNull().default("OPEN"), // OPEN | RESOLVED | CANCELLED
  projectId: integer("project_id").references(() => projects.id),
  resolvedAt: tsz("resolved_at"),
  ...inferred(),
  createdAt: created(),
});

export const meetingsFollowUps = pgTable("as_meetings_followups", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  kind: text("kind").notNull().default("FOLLOW_UP"), // MEETING | CALL | FOLLOW_UP
  scheduledAt: tsz("scheduled_at"),
  personId: integer("person_id").references(() => persons.id),
  projectId: integer("project_id").references(() => projects.id),
  needsClarification: boolean("needs_clarification").notNull().default(false),
  status: text("status").notNull().default("OPEN"), // OPEN | DONE | CANCELLED
  ...inferred(),
  createdAt: created(),
});

export const creativeSubmissions = pgTable("as_creative_submissions", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // SCENARIO DESIGN VIDEO TEXT TASK_RESULT OTHER
  description: text("description"),
  submittedByPersonId: integer("submitted_by_person_id").references(() => persons.id),
  projectId: integer("project_id").references(() => projects.id),
  messageId: integer("message_id"),
  status: text("status").notNull().default("SUBMITTED"), // SUBMITTED APPROVED REJECTED REVISION
  ...inferred(),
  createdAt: created(),
});

export const feedbackEvents = pgTable("as_feedback_events", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").references(() => creativeSubmissions.id),
  subjectKind: text("subject_kind").notNull(), // SCENARIO DESIGN VIDEO TEXT TASK RESULT OTHER
  reaction: text("reaction").notNull(), // APPROVE REJECT REVISION NEUTRAL
  explicitReason: text("explicit_reason"),
  inferredReason: text("inferred_reason"),
  needsClarification: boolean("needs_clarification").notNull().default(false),
  projectId: integer("project_id").references(() => projects.id),
  personId: integer("person_id").references(() => persons.id),
  ...inferred(),
  createdAt: created(),
});

// ---------------------------------------------------------------- learning

export const preferences = pgTable(
  "as_preferences",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull(), // GLOBAL PROJECT PERSON SCENARIO DESIGN VIDEO MANAGEMENT COMMUNICATION
    projectId: integer("project_id").references(() => projects.id),
    personId: integer("person_id").references(() => persons.id),
    statement: text("statement").notNull(),
    rationale: text("rationale"),
    confidence: real("confidence").notNull().default(0.2),
    evidenceCount: integer("evidence_count").notNull().default(0),
    supportingCount: real("supporting_count").notNull().default(0),
    contradictingCount: real("contradicting_count").notNull().default(0),
    confirmedByOwner: boolean("confirmed_by_owner").notNull().default(false),
    rejectedByOwner: boolean("rejected_by_owner").notNull().default(false),
    status: text("status").notNull().default("HYPOTHESIS"), // HYPOTHESIS LIKELY STABLE REJECTED
    lastEvidenceAt: tsz("last_evidence_at"),
    /** Project-scoped learning whose project is still unknown; resolved when the owner answers the project question for this batch. */
    pendingProjectBatchId: integer("pending_project_batch_id"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("as_prefs_scope_idx").on(t.scope, t.projectId)],
);

export const learningEvidence = pgTable("as_learning_evidence", {
  id: serial("id").primaryKey(),
  preferenceId: integer("preference_id").references(() => preferences.id),
  messageIds: integer("message_ids").array().notNull().default([]),
  feedbackEventId: integer("feedback_event_id"),
  learningQuestionId: integer("learning_question_id"),
  polarity: text("polarity").notNull(), // SUPPORTS | CONTRADICTS
  weight: real("weight").notNull().default(1),
  source: text("source").notNull(), // CHAT | OWNER_ANSWER | OWNER_STATEMENT
  note: text("note"),
  active: boolean("active").notNull().default(true),
  needsReview: boolean("needs_review").notNull().default(false),
  createdAt: created(),
});

export const learningQuestions = pgTable(
  "as_learning_questions",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // PROJECT NEW_PROJECT ROLE FEEDBACK_REASON PREFERENCE OTHER
    question: text("question").notNull(),
    context: jsonb("context").notNull().default({}),
    options: jsonb("options").notNull().default([]),
    dedupeKey: text("dedupe_key").notNull(),
    importance: real("importance").notNull().default(0.5),
    status: text("status").notNull().default("OPEN"), // OPEN ASKED RESOLVED PARTIALLY_RESOLVED DISMISSED
    followUpCount: integer("follow_up_count").notNull().default(0),
    askedAt: tsz("asked_at"),
    lastPromptAt: tsz("last_prompt_at"),
    telegramMessageId: tgId("telegram_message_id"),
    answers: jsonb("answers").notNull().default([]),
    resolution: text("resolution"),
    projectId: integer("project_id"),
    personId: integer("person_id"),
    taskId: integer("task_id"),
    feedbackEventId: integer("feedback_event_id"),
    preferenceId: integer("preference_id"),
    batchId: integer("batch_id"),
    resolvedAt: tsz("resolved_at"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("as_lq_dedupe_uidx").on(t.dedupeKey), index("as_lq_status_idx").on(t.status)],
);

export const ownerNotes = pgTable("as_owner_notes", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  projectId: integer("project_id"),
  sourceMessageId: integer("source_message_id"),
  createdAt: created(),
});

// ---------------------------------------------------------------- reports & cost

export const reports = pgTable("as_reports", {
  id: serial("id").primaryKey(),
  slot: text("slot").notNull(), // MORNING MIDDAY EVENING MANUAL
  reportDate: date("report_date", { mode: "string" }).notNull(),
  text: text("text").notNull(),
  model: text("model"),
  usedAi: boolean("used_ai").notNull().default(false),
  telegramMessageIds: bigint("telegram_message_ids", { mode: "number" }).array().notNull().default([]),
  createdAt: created(),
});

export const reportRuns = pgTable(
  "as_report_runs",
  {
    id: serial("id").primaryKey(),
    reportDate: date("report_date", { mode: "string" }).notNull(),
    slot: text("slot").notNull(),
    status: text("status").notNull().default("PENDING"), // PENDING SENDING SENT FAILED SKIPPED
    attempts: integer("attempts").notNull().default(0),
    lockedAt: tsz("locked_at"),
    sentAt: tsz("sent_at"),
    reportId: integer("report_id"),
    trigger: text("trigger"),
    error: text("error"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("as_report_runs_uidx").on(t.reportDate, t.slot)],
);

export const aiUsage = pgTable(
  "as_ai_usage",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").notNull(), // BATCH_ANALYSIS TRANSCRIPTION LEARNING QUESTION_EVALUATION REPORT USER_QUERY
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    batchId: integer("batch_id"),
    success: boolean("success").notNull().default(true),
    createdAt: created(),
  },
  (t) => [index("as_ai_usage_created_idx").on(t.createdAt)],
);

export const budgetAlerts = pgTable(
  "as_budget_alerts",
  {
    month: text("month").notNull(),
    threshold: integer("threshold").notNull(),
    sentAt: created(),
  },
  (t) => [primaryKey({ columns: [t.month, t.threshold] })],
);

/** Small key/value runtime state (e.g. paused flags). */
export const appState = pgTable("as_app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updated(),
});
