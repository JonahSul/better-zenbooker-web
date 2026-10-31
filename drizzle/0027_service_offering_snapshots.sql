CREATE TABLE `service_offering_snapshots` (
 `id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL,
 `revision` integer NOT NULL,
 `status` text NOT NULL,
 `snapshot_json` text NOT NULL,
 `source` text NOT NULL,
 `created_at` integer NOT NULL,
 `expires_at` integer NOT NULL,
 `content_hash` text NOT NULL,
 `approved_by` text,
 `approved_at` integer,
 `request_key` text NOT NULL,
 `request_hash` text NOT NULL,
 `operations_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_offering_request` ON `service_offering_snapshots` (`workspace_id`,`request_key`);
