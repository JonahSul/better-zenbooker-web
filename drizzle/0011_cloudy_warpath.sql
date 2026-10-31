CREATE TABLE `admin_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_chat_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`request_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_chat_turn_dedup` ON `admin_chat_turns` (`workspace_id`,`google_subject`,`request_key`);--> statement-breakpoint
CREATE TABLE `admin_operation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`request_key` text NOT NULL,
	`tool` text NOT NULL,
	`args_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`audit_id` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_operation_dedup` ON `admin_operation_runs` (`workspace_id`,`google_subject`,`request_key`);--> statement-breakpoint
CREATE TABLE `admin_settings` (
	`workspace_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `google_subject`, `key`)
);
--> statement-breakpoint
CREATE TABLE `memory_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`namespace` text NOT NULL,
	`owner_subject` text,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`relation` text NOT NULL,
	`tombstoned_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_edge_identity` ON `memory_edges` (`from_id`,`to_id`,`relation`);--> statement-breakpoint
CREATE TABLE `memory_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`namespace` text NOT NULL,
	`owner_subject` text,
	`current_revision` integer NOT NULL,
	`tombstoned_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_versions` (
	`node_id` text NOT NULL,
	`revision` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`provenance_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `public_document_metrics` (
	`bucket_start` integer NOT NULL,
	`outcome` text NOT NULL,
	`cache_state` text NOT NULL,
	`request_count` integer NOT NULL,
	`duration_us` integer NOT NULL,
	`snapshot_count` integer NOT NULL,
	`snapshot_us` integer NOT NULL,
	`cache_count` integer NOT NULL,
	`cache_us` integer NOT NULL,
	`h1` integer NOT NULL,
	`h5` integer NOT NULL,
	`h10` integer NOT NULL,
	`h25` integer NOT NULL,
	`h50` integer NOT NULL,
	`h100` integer NOT NULL,
	`h250` integer NOT NULL,
	`h500` integer NOT NULL,
	`h1000` integer NOT NULL,
	`h5000` integer NOT NULL,
	`h_above` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `outcome`, `cache_state`)
);
--> statement-breakpoint
CREATE TABLE `vector_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`node_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`vector_id` text NOT NULL,
	`mutation_id` text,
	`error_class` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vector_outbox_dedup` ON `vector_outbox` (`node_id`,`revision`,`action`);--> statement-breakpoint
ALTER TABLE `inquiries` ADD `deleted_at` integer;