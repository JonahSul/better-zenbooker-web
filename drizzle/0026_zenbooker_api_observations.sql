CREATE TABLE `zenbooker_api_runs` (
 `id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL,
 `request_key` text NOT NULL,
 `generation` text NOT NULL,
 `revision` integer NOT NULL,
 `run_json` text NOT NULL,
 `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zenbooker_api_request` ON `zenbooker_api_runs` (`workspace_id`,`request_key`);
--> statement-breakpoint
CREATE TABLE `zenbooker_api_observations` (
 `workspace_id` text NOT NULL,
 `generation` text NOT NULL,
 `resource` text NOT NULL,
 `provider_id` text NOT NULL,
 `observation_json` text NOT NULL,
 `run_id` text NOT NULL,
 `observed_at` integer NOT NULL,
 PRIMARY KEY (`workspace_id`,`generation`,`resource`,`provider_id`)
);
