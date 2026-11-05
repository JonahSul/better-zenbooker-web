CREATE TABLE `support_budget_sessions` (
	`installation_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`security_subject` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `visitor_hash`)
);

--> statement-breakpoint
CREATE TABLE `support_security_wallets` (
	`installation_id` text NOT NULL,
	`security_subject` text NOT NULL,
	`session_hash` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`retain_until` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `security_subject`)
);

--> statement-breakpoint
CREATE TABLE `visitor_abuse_account_lock` (
	`account_id` text PRIMARY KEY NOT NULL,
	`claim_token` text,
	`claim_until` integer DEFAULT 0 NOT NULL,
	`pending_subject` text
);

--> statement-breakpoint
CREATE TABLE `visitor_abuse_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL
);

--> statement-breakpoint
CREATE TABLE `visitor_abuse_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`request_key` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`action` text,
	`until_at` integer,
	`hobby` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `visitor_abuse_request` ON `visitor_abuse_receipts` (`workspace_id`,`subject_hash`,`request_key`);
--> statement-breakpoint
CREATE TABLE `visitor_abuse_runner_nonces` (
	`workspace_id` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `nonce`)
);

--> statement-breakpoint
CREATE TABLE `visitor_abuse_subjects` (
	`workspace_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`scope` text NOT NULL,
	`warning_until` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_receipt` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `subject_hash`)
);

--> statement-breakpoint
CREATE TABLE `visitor_abuse_waf` (
	`workspace_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`ip_ciphertext` text NOT NULL,
	`desired` integer NOT NULL,
	`generation` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text NOT NULL,
	`operation_key` text NOT NULL,
	`operation_id` text,
	`submitted_generation` integer,
	`submitted_desired` integer,
	`claim_token` text,
	`claim_until` integer DEFAULT 0 NOT NULL,
	`next_at` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`attention` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `subject_hash`)
);

--> statement-breakpoint
CREATE INDEX `visitor_abuse_waf_due` ON `visitor_abuse_waf` (`workspace_id`,`next_at`);
