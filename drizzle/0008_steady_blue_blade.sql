CREATE TABLE `analysis_recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`version_id` text NOT NULL,
	`definition_json` text NOT NULL,
	`rationale` text NOT NULL,
	`status` text NOT NULL,
	`accepted_version_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`version_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_run_idempotency` ON `analysis_runs` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `analytics_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`project_id` integer NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`window_from` integer NOT NULL,
	`window_to` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`metrics_json` text NOT NULL,
	`sample_json` text NOT NULL,
	`ingested_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `measurement_dispatches` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_name` text NOT NULL,
	`status` text NOT NULL,
	`error_class` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `measurement_grants` (
	`subject_hash` text PRIMARY KEY NOT NULL,
	`analytics` integer NOT NULL,
	`experiments` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_budgets` (
	`provider` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer NOT NULL,
	`input_reserved` integer NOT NULL,
	`output_reserved` integer NOT NULL,
	PRIMARY KEY(`provider`, `day`)
);
--> statement-breakpoint
CREATE TABLE `provider_diagnostics` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`evidence_json` text NOT NULL,
	`proposed_fix` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_health` (
	`provider` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`error_class` text,
	`latency_ms` integer,
	`failure_count` integer NOT NULL,
	`next_retry_at` integer,
	`circuit_until` integer,
	`source_fetched_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_settings` (
	`provider` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`config_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER analytics_snapshot_no_update BEFORE UPDATE ON analytics_snapshots BEGIN SELECT RAISE(ABORT,'Imported evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER analytics_snapshot_no_delete BEFORE DELETE ON analytics_snapshots BEGIN SELECT RAISE(ABORT,'Imported evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_run_input_guard BEFORE UPDATE OF idempotency_key,input_hash,version_id,mode,input_json,created_by,created_at ON analysis_runs BEGIN SELECT RAISE(ABORT,'Run input is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_run_completed_guard BEFORE UPDATE ON analysis_runs WHEN OLD.status!='running' BEGIN SELECT RAISE(ABORT,'Completed evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_recommendation_definition_guard BEFORE UPDATE OF run_id,version_id,definition_json,rationale,created_at ON analysis_recommendations BEGIN SELECT RAISE(ABORT,'Proposal evidence is immutable'); END;
