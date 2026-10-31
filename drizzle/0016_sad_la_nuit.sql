CREATE TABLE `action_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`thread_id` text NOT NULL,
	`tool` text NOT NULL,
	`args_json` text NOT NULL,
	`args_hash` text NOT NULL,
	`resource_revision` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer
);
--> statement-breakpoint
ALTER TABLE `inquiries` ADD `workspace_id` text DEFAULT 'installation' NOT NULL;