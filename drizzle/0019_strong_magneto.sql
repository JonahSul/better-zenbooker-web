CREATE TABLE `hosted_bridge_inbox` (
	`workspace_id` text NOT NULL,
	`remote_id` integer NOT NULL,
	`event_key` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`imported_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `remote_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_inbox_event_key` ON `hosted_bridge_inbox` (`workspace_id`,`event_key`);--> statement-breakpoint
CREATE TABLE `hosted_bridge_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_key` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_operation_idempotency` ON `hosted_bridge_operations` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `hosted_bridge_state` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`credential_revision` integer NOT NULL,
	`credential_json` text NOT NULL,
	`operation_token` text,
	`bridge_verifier` text NOT NULL,
	`callback_verifier` text NOT NULL,
	`pending_json` text,
	`config_json` text NOT NULL,
	`cursor` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hosted_catalog_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer
);
--> statement-breakpoint
CREATE TABLE `hosted_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`grant_revision` integer NOT NULL,
	`service_id` text,
	`placement` text NOT NULL,
	`version_id` text,
	`composition_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hosted_reported_bookings` (
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`job_id` text NOT NULL,
	`event_key` text NOT NULL,
	`metric` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `account_id`, `job_id`)
);
