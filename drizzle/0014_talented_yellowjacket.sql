CREATE TABLE `analytics_snapshots_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`project_id` integer NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`window_json` text NOT NULL,
	`summary_json` text NOT NULL,
	`detail_sample_json` text,
	`fetched_at` text NOT NULL,
	`ingested_by` text NOT NULL,
	`created_at` integer NOT NULL
);
