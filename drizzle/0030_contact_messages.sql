CREATE TABLE `contact_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`name` text,
	`email` text,
	`message` text,
	`status` text DEFAULT 'new' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`deleted_at` integer,
	`last_write_token` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_messages_workspace_request` ON `contact_messages` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `contact_messages_workspace_created` ON `contact_messages` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_messages_workspace_expiry` ON `contact_messages` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `contact_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`event` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`config_revision` integer NOT NULL,
	`config_fingerprint` text,
	`credential_generation` text,
	`attention_reason` text,
	`claim_token` text,
	`attempted_at` integer,
	`provider_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_outbox_source_event` ON `contact_outbox` (`workspace_id`,`event`,`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `contact_outbox_workspace_state` ON `contact_outbox` (`workspace_id`,`state`);