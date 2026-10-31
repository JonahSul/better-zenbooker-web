CREATE TABLE `customer_google_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`browser_hash` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`verifier_ciphertext` text NOT NULL,
	`return_to` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `customer_google_prefill_sessions` (
	`session_hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issuer` text NOT NULL,
	`google_subject` text NOT NULL,
	`profile_ciphertext` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`intent_return_to` text NOT NULL,
	`intent_expires_at` integer NOT NULL,
	`intent_consumed_at` integer,
	`browser_hash` text NOT NULL,
	`revoked_at` integer
);

