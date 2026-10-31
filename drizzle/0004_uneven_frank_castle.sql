CREATE TABLE `exp_assignments` (
	`version_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`composition_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`version_id`, `subject_hash`)
);
--> statement-breakpoint
CREATE TABLE `exp_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`rationale` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exp_compositions` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`label` text NOT NULL,
	`allocation` integer NOT NULL,
	`definition_json` text NOT NULL,
	`snapshot_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exp_composition_label` ON `exp_compositions` (`version_id`,`label`);--> statement-breakpoint
CREATE TABLE `exp_conversions` (
	`inquiry_id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`composition_id` text NOT NULL,
	`stage` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exp_exposures` (
	`version_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`composition_id` text NOT NULL,
	`stage` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`version_id`, `subject_hash`)
);
--> statement-breakpoint
CREATE TABLE `exp_feedback` (
	`version_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`section` text NOT NULL,
	`composition_id` text NOT NULL,
	`vote` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`version_id`, `subject_hash`, `section`)
);
--> statement-breakpoint
CREATE TABLE `exp_runtime` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_version_id` text,
	`baseline_hash` text,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exp_snapshots` (
	`hash` text PRIMARY KEY NOT NULL,
	`html` text NOT NULL,
	`renderer_version` text NOT NULL,
	`asset_manifest_hash` text NOT NULL,
	`rules_version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exp_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`stage` text NOT NULL,
	`revision` integer NOT NULL,
	`edit_token` text NOT NULL,
	`rules_json` text NOT NULL,
	`source_version` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER exp_snapshot_no_update BEFORE UPDATE ON exp_snapshots BEGIN SELECT RAISE(ABORT,'Snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_snapshot_no_delete BEFORE DELETE ON exp_snapshots BEGIN SELECT RAISE(ABORT,'Snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_composition_update_guard BEFORE UPDATE ON exp_compositions WHEN (SELECT stage FROM exp_versions WHERE id=OLD.version_id)!='draft' BEGIN SELECT RAISE(ABORT,'Version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_composition_delete_guard BEFORE DELETE ON exp_compositions WHEN (SELECT stage FROM exp_versions WHERE id=OLD.version_id)!='draft' BEGIN SELECT RAISE(ABORT,'Version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_composition_insert_guard BEFORE INSERT ON exp_compositions WHEN (SELECT stage FROM exp_versions WHERE id=NEW.version_id)!='draft' BEGIN SELECT RAISE(ABORT,'Version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_version_definition_guard BEFORE UPDATE OF title,rules_json,source_version,created_by,created_at,edit_token,revision ON exp_versions WHEN OLD.stage!='draft' BEGIN SELECT RAISE(ABORT,'Version definition is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_version_delete_guard BEFORE DELETE ON exp_versions WHEN OLD.stage!='draft' BEGIN SELECT RAISE(ABORT,'Version history is immutable'); END;
--> statement-breakpoint
CREATE UNIQUE INDEX exp_only_one_running ON exp_versions(stage) WHERE stage='running';
--> statement-breakpoint
CREATE TRIGGER exp_assignment_no_update BEFORE UPDATE ON exp_assignments BEGIN SELECT RAISE(ABORT,'Assignment is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_exposure_no_update BEFORE UPDATE ON exp_exposures BEGIN SELECT RAISE(ABORT,'Exposure is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_conversion_no_update BEFORE UPDATE ON exp_conversions BEGIN SELECT RAISE(ABORT,'Conversion is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_version_stage_guard BEFORE UPDATE OF stage ON exp_versions WHEN NOT (OLD.stage=NEW.stage OR (OLD.stage='draft' AND NEW.stage='running') OR (OLD.stage='running' AND NEW.stage='paused')) BEGIN SELECT RAISE(ABORT,'Invalid immutable version transition'); END;
--> statement-breakpoint
CREATE TRIGGER exp_composition_target_guard BEFORE UPDATE OF version_id ON exp_compositions WHEN (SELECT stage FROM exp_versions WHERE id=NEW.version_id)!='draft' BEGIN SELECT RAISE(ABORT,'Target version is immutable'); END;
