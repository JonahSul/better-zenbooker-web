CREATE TABLE `booking_experiment_conversions` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`composition_id` text NOT NULL,
	`traffic_stage` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `booking_metrics` ADD `traffic_stage` text DEFAULT 'demo' NOT NULL;