CREATE TABLE `support_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`input_bytes` integer NOT NULL,
	`status` text NOT NULL,
	`usage_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_curation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_key` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_curation_request` ON `support_curation_runs` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `support_daily_usage` (
	`workspace_id` text NOT NULL,
	`day` integer NOT NULL,
	`calls` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `support_feedback` (
	`workspace_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`turn_id` text NOT NULL,
	`vote` text NOT NULL,
	`reason` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `visitor_hash`, `turn_id`)
);
--> statement-breakpoint
CREATE TABLE `support_kb_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`revision` integer NOT NULL,
	`retired_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_kb_versions` (
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text NOT NULL,
	`approved_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `support_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_id` text,
	`base_revision` integer NOT NULL,
	`draft_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE TABLE `support_proxy_state` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`credential_json` text NOT NULL,
	`verifier` text NOT NULL,
	`config_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`revision` integer NOT NULL,
	`preferences_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`memory_expires_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `support_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`thread_id` text NOT NULL,
	`request_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`message` text NOT NULL,
	`answer` text,
	`knowledge_json` text,
	`result_json` text,
	`status` text NOT NULL,
	`thread_revision` integer NOT NULL,
	`session_revision` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_turn_request` ON `support_turns` (`workspace_id`,`visitor_hash`,`request_key`);
--> statement-breakpoint
CREATE VIRTUAL TABLE support_kb_fts USING fts5(document_id UNINDEXED, revision UNINDEXED, title, body, tokenize='unicode61');

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint
