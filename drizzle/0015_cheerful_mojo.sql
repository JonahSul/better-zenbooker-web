CREATE TABLE `approved_baseline_runtime` (
	`id` integer PRIMARY KEY NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approved_baselines` (
	`hash` text PRIMARY KEY NOT NULL,
	`html` text NOT NULL,
	`renderer_version` text NOT NULL,
	`asset_manifest_hash` text NOT NULL,
	`rules_version` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);

--> statement-breakpoint
CREATE TRIGGER approved_baseline_no_update BEFORE UPDATE ON approved_baselines BEGIN SELECT RAISE(ABORT,'Approved baselines are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER approved_baseline_no_delete BEFORE DELETE ON approved_baselines BEGIN SELECT RAISE(ABORT,'Approved baselines are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER memory_version_no_update BEFORE UPDATE ON memory_versions BEGIN SELECT RAISE(ABORT,'Memory revisions are immutable'); END;
