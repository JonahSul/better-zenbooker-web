CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appointment_provider_reference` ON `appointments` (`workspace_id`,`provider_id`);--> statement-breakpoint
CREATE TABLE `booking_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`browser_hash` text NOT NULL,
	`customer_id` text,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`selected_json` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_metrics` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`metric` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`result_json` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_operation_key` ON `booking_operations` (`workspace_id`,`customer_id`,`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `booking_target_once` ON `booking_operations` (`workspace_id`,`kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `booking_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`config_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`recipient` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`browser_hash` text NOT NULL,
	`digest` text NOT NULL,
	`consume_token` text,
	`expires_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_rate_windows` (
	`key` text PRIMARY KEY NOT NULL,
	`window` integer NOT NULL,
	`attempts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_workspace_email` ON `customers` (`workspace_id`,`email`);