CREATE TABLE `admin_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`google_subject` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`site_user_id` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`session_hash` text PRIMARY KEY NOT NULL,
	`site_user_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
