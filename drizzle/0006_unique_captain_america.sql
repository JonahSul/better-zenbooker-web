CREATE TABLE `app_credential_attempts` (
	`project_id` text NOT NULL,
	`window` integer NOT NULL,
	`attempts` integer NOT NULL,
	PRIMARY KEY(`project_id`, `window`)
);
--> statement-breakpoint
CREATE TABLE `app_credential_state` (
	`project_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`sealed_at` integer,
	`operation_token` text
);
--> statement-breakpoint
CREATE TABLE `app_credentials` (
	`project_id` text NOT NULL,
	`credential_key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `credential_key`)
);
--> statement-breakpoint
ALTER TABLE `admin_oauth_states` ADD `config_fingerprint` text;--> statement-breakpoint
ALTER TABLE `admin_oauth_states` ADD `config_revision` integer;--> statement-breakpoint
ALTER TABLE `admin_sessions` ADD `config_fingerprint` text;--> statement-breakpoint
CREATE TRIGGER app_credential_seal_sticky BEFORE UPDATE OF sealed_at ON app_credential_state WHEN OLD.sealed_at IS NOT NULL AND (NEW.sealed_at IS NULL OR NEW.sealed_at!=OLD.sealed_at) BEGIN SELECT RAISE(ABORT,'Credential bootstrap is permanently sealed'); END;
--> statement-breakpoint
CREATE TRIGGER app_credential_seal_no_delete BEFORE DELETE ON app_credential_state WHEN OLD.sealed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Credential bootstrap is permanently sealed'); END;
