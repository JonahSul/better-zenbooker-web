CREATE TABLE `curation_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`text` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `curation_prompt_revision` ON `curation_prompts` (`revision`);--> statement-breakpoint
CREATE TRIGGER curation_prompt_no_update BEFORE UPDATE ON curation_prompts BEGIN SELECT RAISE(ABORT,'Prompt versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER curation_prompt_no_delete BEFORE DELETE ON curation_prompts BEGIN SELECT RAISE(ABORT,'Prompt versions are immutable'); END;
