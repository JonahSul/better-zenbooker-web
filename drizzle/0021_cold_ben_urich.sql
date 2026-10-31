CREATE TABLE `hosted_booking_references` (
	`workspace_id` text NOT NULL,
	`ref_hash` text NOT NULL,
	`analytics_grant_hash` text NOT NULL,
	`analytics_revision` integer NOT NULL,
	`service_id` text,
	`placement` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`experiment_subject_hash` text,
	`experiment_revision` integer,
	`version_id` text,
	`composition_id` text,
	PRIMARY KEY(`workspace_id`, `ref_hash`)
);
