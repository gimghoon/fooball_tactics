CREATE TABLE `evidence_search_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`url` text NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text NOT NULL,
	`publisher` text NOT NULL,
	`published_at` text NOT NULL,
	`retrieved_at` integer,
	`document_type` text NOT NULL,
	`quote` text NOT NULL,
	`relevance` text NOT NULL,
	`trust_tier` integer NOT NULL,
	`rank` integer NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`selected_by` text,
	`selected_at` integer,
	`source_id` text,
	`content_hash` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`,`bundle_id`) REFERENCES `evidence_search_runs`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_search_candidate_run_url` ON `evidence_search_candidates` (`run_id`,`canonical_url`);--> statement-breakpoint
CREATE INDEX `idx_search_candidate_bundle_status` ON `evidence_search_candidates` (`bundle_id`,`status`);--> statement-breakpoint
CREATE TABLE `evidence_search_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`input_version` text NOT NULL,
	`bundle_version` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`search_model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`query_json` text NOT NULL,
	`error_message` text,
	`is_stale` integer DEFAULT false NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_search_runs_input` ON `evidence_search_runs` (`bundle_id`,`input_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_search_runs_id_bundle` ON `evidence_search_runs` (`id`,`bundle_id`);--> statement-breakpoint
ALTER TABLE `evidence_sources` ADD `origin` text DEFAULT 'uploaded' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence_sources` ADD `canonical_url` text;--> statement-breakpoint
ALTER TABLE `evidence_sources` ADD `publisher` text;--> statement-breakpoint
ALTER TABLE `evidence_sources` ADD `published_at` text;--> statement-breakpoint
ALTER TABLE `evidence_sources` ADD `retrieved_at` integer;--> statement-breakpoint
ALTER TABLE `evidence_sources` ADD `search_candidate_id` text;--> statement-breakpoint
ALTER TABLE `evidence_sources` ADD `external_text_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_sources_bundle_canonical_url` ON `evidence_sources` (`bundle_id`,`canonical_url`) WHERE "evidence_sources"."canonical_url" IS NOT NULL;