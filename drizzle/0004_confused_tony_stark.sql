CREATE TABLE `evidence_analysis_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`input_version` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`analyzer_model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`error_message` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_evidence_analysis_jobs_status" CHECK("evidence_analysis_jobs"."status" IN ('queued', 'running', 'review_ready', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_analysis_jobs_input_version` ON `evidence_analysis_jobs` (`input_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_analysis_jobs_id_bundle` ON `evidence_analysis_jobs` (`id`,`bundle_id`);--> statement-breakpoint
CREATE TABLE `evidence_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_audit_events_bundle_created_at` ON `evidence_audit_events` (`bundle_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `evidence_bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`purpose` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`source_id` text,
	`video_clip_id` text,
	`ordinal` integer NOT NULL,
	`location_label` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`,`bundle_id`) REFERENCES `evidence_sources`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_clip_id`,`bundle_id`) REFERENCES `evidence_video_clips`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_evidence_chunks_exactly_one_provenance" CHECK(("evidence_chunks"."source_id" IS NULL) != ("evidence_chunks"."video_clip_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_chunks_id_bundle` ON `evidence_chunks` (`id`,`bundle_id`);--> statement-breakpoint
CREATE TABLE `evidence_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`original_file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_hash` text NOT NULL,
	`storage_key` text NOT NULL,
	`extracted_text_key` text,
	`extraction_status` text DEFAULT 'pending' NOT NULL,
	`extraction_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_evidence_sources_media_type_and_size" CHECK("evidence_sources"."media_type" IN ('application/pdf', 'text/plain', 'text/markdown') AND "evidence_sources"."byte_size" BETWEEN 0 AND 20971520)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_sources_bundle_content_hash` ON `evidence_sources` (`bundle_id`,`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_sources_id_bundle` ON `evidence_sources` (`id`,`bundle_id`);--> statement-breakpoint
CREATE TABLE `evidence_video_clips` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`url` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`observation` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_evidence_video_clips_https_timecodes" CHECK("evidence_video_clips"."url" LIKE 'https://%' AND "evidence_video_clips"."start_ms" >= 0 AND "evidence_video_clips"."end_ms" > "evidence_video_clips"."start_ms")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_video_clips_id_bundle` ON `evidence_video_clips` (`id`,`bundle_id`);--> statement-breakpoint
CREATE TABLE `tactic_card_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`card_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`,`bundle_id`) REFERENCES `tactic_cards`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chunk_id`,`bundle_id`) REFERENCES `evidence_chunks`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tactic_card_citations_card_chunk` ON `tactic_card_citations` (`card_id`,`chunk_id`);--> statement-breakpoint
CREATE TABLE `tactic_card_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`status` text NOT NULL,
	`content_json` text NOT NULL,
	`citation_snapshot_json` text NOT NULL,
	`bundle_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `tactic_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_tactic_card_reviews_status" CHECK("tactic_card_reviews"."status" IN ('analysis_draft', 'owner_reviewed', 'coach_reviewed', 'held', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE `tactic_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`job_id` text NOT NULL,
	`bundle_version` text NOT NULL,
	`status` text DEFAULT 'analysis_draft' NOT NULL,
	`draft_content_json` text NOT NULL,
	`current_content_json` text NOT NULL,
	`is_stale` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`,`bundle_id`) REFERENCES `evidence_analysis_jobs`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_tactic_cards_status" CHECK("tactic_cards"."status" IN ('analysis_draft', 'owner_reviewed', 'coach_reviewed', 'held', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_tactic_cards_bundle_status` ON `tactic_cards` (`bundle_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tactic_cards_id_bundle` ON `tactic_cards` (`id`,`bundle_id`);