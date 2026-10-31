ALTER TABLE `support_photos` ADD `upload_state` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `support_photos` ADD `upload_lease_until` integer;