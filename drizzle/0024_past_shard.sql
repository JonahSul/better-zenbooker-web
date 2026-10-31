CREATE TABLE `exp_management_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`request_key` text NOT NULL,
	`action` text NOT NULL,
	`args_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exp_management_request` ON `exp_management_operations` (`subject`,`request_key`);--> statement-breakpoint
CREATE TABLE `exp_version_management` (
	`version_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`archived_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
--> statement-breakpoint
CREATE TRIGGER exp_management_create AFTER INSERT ON exp_versions BEGIN INSERT INTO exp_version_management(version_id,revision) VALUES(NEW.id,0); END;
--> statement-breakpoint
CREATE TRIGGER exp_management_edit_guard BEFORE UPDATE ON exp_versions WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=OLD.id AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT,'Restore this version before changing it'); END;
--> statement-breakpoint
CREATE TRIGGER exp_management_composition_insert BEFORE INSERT ON exp_compositions WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_management_composition_update BEFORE UPDATE ON exp_compositions WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id IN(OLD.version_id,NEW.version_id) AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_management_composition_delete BEFORE DELETE ON exp_compositions WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=OLD.version_id AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_management_runtime_guard BEFORE UPDATE ON exp_runtime WHEN EXISTS(SELECT 1 FROM exp_version_management m WHERE (m.archived_at IS NOT NULL OR m.deleted_at IS NOT NULL) AND (m.version_id=NEW.active_version_id)) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER exp_management_source_guard BEFORE INSERT ON exp_versions WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.source_version AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Source version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER exp_assignments_management_reference_guard BEFORE INSERT ON exp_assignments WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER exp_exposures_management_reference_guard BEFORE INSERT ON exp_exposures WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER exp_conversions_management_reference_guard BEFORE INSERT ON exp_conversions WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER exp_feedback_management_reference_guard BEFORE INSERT ON exp_feedback WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER analysis_runs_management_reference_guard BEFORE INSERT ON analysis_runs WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER booking_experiment_conversions_management_reference_guard BEFORE INSERT ON booking_experiment_conversions WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER hosted_handoffs_management_reference_guard BEFORE INSERT ON hosted_handoffs WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER hosted_booking_references_management_reference_guard BEFORE INSERT ON hosted_booking_references WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;

--> statement-breakpoint
CREATE TRIGGER analysis_recommendation_management_guard BEFORE INSERT ON analysis_recommendations WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id IN(NEW.version_id,NEW.accepted_version_id) AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_recommendation_management_update_guard BEFORE UPDATE OF accepted_version_id ON analysis_recommendations WHEN EXISTS(SELECT 1 FROM exp_version_management WHERE version_id=NEW.accepted_version_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Version is unavailable'); END;
