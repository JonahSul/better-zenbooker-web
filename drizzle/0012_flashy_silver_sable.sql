ALTER TABLE `memory_nodes` ADD `mutation_token` text;--> statement-breakpoint
ALTER TABLE `vector_outbox` ADD `vector_json` text;--> statement-breakpoint
ALTER TABLE `vector_outbox` ADD `lease_token` text;