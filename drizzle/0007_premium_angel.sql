ALTER TABLE `google_connections` ADD `config_fingerprint` text;--> statement-breakpoint
ALTER TABLE `google_oauth_states` ADD `config_fingerprint` text;--> statement-breakpoint
ALTER TABLE `google_oauth_states` ADD `config_revision` integer;