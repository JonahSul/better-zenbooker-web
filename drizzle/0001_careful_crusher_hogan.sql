CREATE TABLE `google_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`encrypted_refresh_token` text NOT NULL,
	`account_name` text,
	`location_name` text,
	`location_title` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `google_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
