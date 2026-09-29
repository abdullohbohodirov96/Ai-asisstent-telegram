CREATE TABLE "as_ai_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"batch_id" integer,
	"success" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_analysis_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"model" text NOT NULL,
	"output" jsonb NOT NULL,
	"importance" real DEFAULT 0 NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "as_analysis_results_batch_id_unique" UNIQUE("batch_id")
);
--> statement-breakpoint
CREATE TABLE "as_app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_budget_alerts" (
	"month" text NOT NULL,
	"threshold" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "as_budget_alerts_month_threshold_pk" PRIMARY KEY("month","threshold")
);
--> statement-breakpoint
CREATE TABLE "as_business_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"user_chat_id" bigint,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"can_reply" boolean DEFAULT false NOT NULL,
	"rights" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"business_connection_id" text,
	"title" text,
	"person_id" integer,
	"default_project_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_commitments" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer,
	"who_text" text,
	"to_person_id" integer,
	"to_text" text,
	"what" text NOT NULL,
	"promised_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"project_id" integer,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_message_ids" integer[] DEFAULT '{}' NOT NULL,
	"batch_id" integer,
	"chat_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_creative_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"submitted_by_person_id" integer,
	"project_id" integer,
	"message_id" integer,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_message_ids" integer[] DEFAULT '{}' NOT NULL,
	"batch_id" integer,
	"chat_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"what" text NOT NULL,
	"why" text,
	"project_id" integer,
	"decided_at" timestamp with time zone,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_message_ids" integer[] DEFAULT '{}' NOT NULL,
	"batch_id" integer,
	"chat_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_feedback_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer,
	"subject_kind" text NOT NULL,
	"reaction" text NOT NULL,
	"explicit_reason" text,
	"inferred_reason" text,
	"needs_clarification" boolean DEFAULT false NOT NULL,
	"project_id" integer,
	"person_id" integer,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_message_ids" integer[] DEFAULT '{}' NOT NULL,
	"batch_id" integer,
	"chat_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_learning_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"preference_id" integer,
	"message_ids" integer[] DEFAULT '{}' NOT NULL,
	"feedback_event_id" integer,
	"learning_question_id" integer,
	"polarity" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_learning_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"question" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"follow_up_count" integer DEFAULT 0 NOT NULL,
	"asked_at" timestamp with time zone,
	"last_prompt_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution" text,
	"project_id" integer,
	"person_id" integer,
	"task_id" integer,
	"feedback_event_id" integer,
	"preference_id" integer,
	"batch_id" integer,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_meetings_followups" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'FOLLOW_UP' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"person_id" integer,
	"project_id" integer,
	"needs_clarification" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_message_ids" integer[] DEFAULT '{}' NOT NULL,
	"batch_id" integer,
	"chat_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_message_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"error" text,
	"project_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "as_message_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"text" text,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"sender_id" bigint,
	"sender_name" text,
	"direction" text NOT NULL,
	"text" text,
	"transcript" text,
	"media_type" text,
	"file_id" text,
	"reply_to_message_id" bigint,
	"business_connection_id" text,
	"sent_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"analysis_status" text DEFAULT 'PENDING' NOT NULL,
	"batch_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_outbound_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"chat_id" bigint,
	"allowed" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_owner_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"project_id" integer,
	"source_message_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_persons" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_user_id" bigint,
	"name" text NOT NULL,
	"username" text,
	"role" text,
	"role_confidence" real DEFAULT 0 NOT NULL,
	"role_confirmed" boolean DEFAULT false NOT NULL,
	"company" text,
	"notes" text,
	"summary" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"project_id" integer,
	"person_id" integer,
	"statement" text NOT NULL,
	"rationale" text,
	"confidence" real DEFAULT 0.2 NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"supporting_count" real DEFAULT 0 NOT NULL,
	"contradicting_count" real DEFAULT 0 NOT NULL,
	"confirmed_by_owner" boolean DEFAULT false NOT NULL,
	"rejected_by_owner" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'HYPOTHESIS' NOT NULL,
	"last_evidence_at" timestamp with time zone,
	"pending_project_batch_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_project_members" (
	"project_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" text,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "as_project_members_project_id_person_id_pk" PRIMARY KEY("project_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "as_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"goals" text,
	"notes" text,
	"summary" text,
	"confirmed_by_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "as_projects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "as_report_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_date" date NOT NULL,
	"slot" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"report_id" integer,
	"trigger" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"slot" text NOT NULL,
	"report_date" date NOT NULL,
	"text" text NOT NULL,
	"model" text,
	"used_ai" boolean DEFAULT false NOT NULL,
	"telegram_message_ids" bigint[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"project_id" integer,
	"owner_person_id" integer,
	"owner_name_text" text,
	"assigned_by_person_id" integer,
	"status" text DEFAULT 'TODO' NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"deadline" timestamp with time zone,
	"remind_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"source_message_id" integer,
	"needs_clarification" boolean DEFAULT false NOT NULL,
	"stale_evidence" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_message_ids" integer[] DEFAULT '{}' NOT NULL,
	"batch_id" integer,
	"chat_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "as_telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "as_user_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"name" text,
	"communication_style" text,
	"management_style" text,
	"delegation_style" text,
	"decision_style" text,
	"creative_taste" text,
	"scenario_taste" text,
	"design_taste" text,
	"video_taste" text,
	"project_tastes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "as_user_profile_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE "as_waiting_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"person_id" integer,
	"person_text" text,
	"what" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"project_id" integer,
	"resolved_at" timestamp with time zone,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_message_ids" integer[] DEFAULT '{}' NOT NULL,
	"batch_id" integer,
	"chat_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "as_analysis_results" ADD CONSTRAINT "as_analysis_results_batch_id_as_message_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."as_message_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_chats" ADD CONSTRAINT "as_chats_person_id_as_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_commitments" ADD CONSTRAINT "as_commitments_person_id_as_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_commitments" ADD CONSTRAINT "as_commitments_to_person_id_as_persons_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_commitments" ADD CONSTRAINT "as_commitments_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_creative_submissions" ADD CONSTRAINT "as_creative_submissions_submitted_by_person_id_as_persons_id_fk" FOREIGN KEY ("submitted_by_person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_creative_submissions" ADD CONSTRAINT "as_creative_submissions_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_decisions" ADD CONSTRAINT "as_decisions_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_feedback_events" ADD CONSTRAINT "as_feedback_events_submission_id_as_creative_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."as_creative_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_feedback_events" ADD CONSTRAINT "as_feedback_events_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_feedback_events" ADD CONSTRAINT "as_feedback_events_person_id_as_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_learning_evidence" ADD CONSTRAINT "as_learning_evidence_preference_id_as_preferences_id_fk" FOREIGN KEY ("preference_id") REFERENCES "public"."as_preferences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_meetings_followups" ADD CONSTRAINT "as_meetings_followups_person_id_as_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_meetings_followups" ADD CONSTRAINT "as_meetings_followups_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_message_batches" ADD CONSTRAINT "as_message_batches_chat_id_as_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."as_chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_message_versions" ADD CONSTRAINT "as_message_versions_message_id_as_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."as_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_messages" ADD CONSTRAINT "as_messages_chat_id_as_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."as_chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_preferences" ADD CONSTRAINT "as_preferences_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_preferences" ADD CONSTRAINT "as_preferences_person_id_as_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_project_members" ADD CONSTRAINT "as_project_members_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_project_members" ADD CONSTRAINT "as_project_members_person_id_as_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_tasks" ADD CONSTRAINT "as_tasks_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_tasks" ADD CONSTRAINT "as_tasks_owner_person_id_as_persons_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_tasks" ADD CONSTRAINT "as_tasks_assigned_by_person_id_as_persons_id_fk" FOREIGN KEY ("assigned_by_person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_waiting_items" ADD CONSTRAINT "as_waiting_items_person_id_as_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."as_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "as_waiting_items" ADD CONSTRAINT "as_waiting_items_project_id_as_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."as_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "as_ai_usage_created_idx" ON "as_ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "as_chats_kind_tg_uidx" ON "as_chats" USING btree ("kind","telegram_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "as_lq_dedupe_uidx" ON "as_learning_questions" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "as_lq_status_idx" ON "as_learning_questions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "as_batches_chat_window_uidx" ON "as_message_batches" USING btree ("chat_id","window_start","seq");--> statement-breakpoint
CREATE INDEX "as_batches_status_idx" ON "as_message_batches" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "as_messages_chat_tgmsg_uidx" ON "as_messages" USING btree ("chat_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "as_messages_analysis_idx" ON "as_messages" USING btree ("analysis_status","batch_id");--> statement-breakpoint
CREATE INDEX "as_messages_sent_idx" ON "as_messages" USING btree ("sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "as_persons_tg_uidx" ON "as_persons" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "as_prefs_scope_idx" ON "as_preferences" USING btree ("scope","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "as_report_runs_uidx" ON "as_report_runs" USING btree ("report_date","slot");--> statement-breakpoint
CREATE INDEX "as_tasks_status_idx" ON "as_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "as_tg_updates_status_idx" ON "as_telegram_updates" USING btree ("status","next_attempt_at");