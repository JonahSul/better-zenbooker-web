CREATE TABLE `support_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`thread_id` text NOT NULL,
	`revision` integer NOT NULL,
	`object_key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`tombstoned_at` integer,
	`cleanup_attempts` integer DEFAULT 0 NOT NULL,
	`cleanup_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `support_calls` ADD `kind` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `support_turns` ADD `photo_refs_json` text;--> statement-breakpoint
ALTER TABLE `support_turns` ADD `photo_derived` integer DEFAULT 0 NOT NULL;