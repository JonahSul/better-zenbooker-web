CREATE TABLE `inquiries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`submission_key` text NOT NULL,
	`name` text NOT NULL,
	`contact` text NOT NULL,
	`service` text NOT NULL,
	`area` text NOT NULL,
	`preferred_date` text NOT NULL,
	`source` text DEFAULT 'direct' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`revenue_cents` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inquiries_user_submission` ON `inquiries` (`user_id`,`submission_key`);