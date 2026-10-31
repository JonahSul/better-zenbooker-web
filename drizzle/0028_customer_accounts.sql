ALTER TABLE `customer_google_oauth_states` ADD `purpose` text;
--> statement-breakpoint
ALTER TABLE `customer_google_oauth_states` ADD `return_context` text;
--> statement-breakpoint
ALTER TABLE `customer_google_oauth_states` ADD `visit_ref` text;
--> statement-breakpoint
ALTER TABLE `customer_google_prefill_sessions` ADD `intent_purpose` text;
--> statement-breakpoint
ALTER TABLE `customer_google_prefill_sessions` ADD `visit_ref` text;
--> statement-breakpoint
CREATE TABLE `customer_accounts` (
 `id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL,
 `subject_key` text NOT NULL,
 `revision` integer NOT NULL,
 `created_at` integer NOT NULL,
 `expires_at` integer NOT NULL,
 `deleted_at` integer,
 `erased_at` integer,
 `operation_token` text,
 `last_request_key` text,
 `last_request_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_account_identity` ON `customer_accounts` (`workspace_id`,`subject_key`);
--> statement-breakpoint
CREATE TABLE `customer_account_preferences` (
 `account_id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL,
 `revision` integer NOT NULL,
 `preferences_json` text NOT NULL,
 `expires_at` integer NOT NULL,
 `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_account_interactions` (
 `id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL,
 `kind` text NOT NULL,
 `account_id` text,
 `visitor_hash` text NOT NULL,
 `visit_hash` text NOT NULL,
 `event` text,
 `app_ref_json` text NOT NULL,
 `request_key` text NOT NULL,
 `created_at` integer NOT NULL,
 `last_activity_at` integer NOT NULL,
 `expires_at` integer NOT NULL,
 `associated_at` integer,
 `revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_account_visit_event` ON `customer_account_interactions` (`workspace_id`,`visitor_hash`,`visit_hash`,`request_key`);
