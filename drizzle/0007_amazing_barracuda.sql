PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_evidence_analysis_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`input_version` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`analyzer_model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`stage` text DEFAULT 'validate_sources' NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` integer,
	`error_message` text,
	`started_at` integer,
	`completed_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`extracted_evidence_json` text,
	`generated_cards_json` text,
	`is_stale` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_evidence_analysis_jobs_status" CHECK("__new_evidence_analysis_jobs"."status" IN ('queued', 'running', 'review_ready', 'completed', 'failed')),
	CONSTRAINT "ck_evidence_analysis_jobs_stage" CHECK("__new_evidence_analysis_jobs"."stage" IN ('validate_sources', 'extract_text', 'normalize_clips', 'extract_evidence', 'generate_cards', 'persist_cards', 'done'))
);
--> statement-breakpoint
INSERT INTO `__new_evidence_analysis_jobs`("id", "bundle_id", "input_version", "status", "analyzer_model", "prompt_version", "schema_version", "stage", "lease_owner", "lease_token", "lease_expires_at", "error_message", "started_at", "completed_at", "attempt_count", "extracted_evidence_json", "generated_cards_json", "is_stale", "created_at", "updated_at") SELECT "id", "bundle_id", "input_version", "status", "analyzer_model", "prompt_version", "schema_version", CASE "stage"
	WHEN 'validate_sources' THEN 'validate_sources'
	WHEN 'sources_validated' THEN 'extract_text'
	WHEN 'extract_text' THEN 'extract_text'
	WHEN 'text_extracted' THEN 'normalize_clips'
	WHEN 'normalize_clips' THEN 'normalize_clips'
	WHEN 'chunks_ready' THEN 'extract_evidence'
	WHEN 'extract_evidence' THEN 'extract_evidence'
	WHEN 'done' THEN 'done'
	WHEN 'completed' THEN 'done'
	ELSE 'extract_evidence'
END, "lease_owner", NULL, "lease_expires_at", "error_message", "started_at", "completed_at", 0, NULL, NULL, "is_stale", "created_at", "updated_at" FROM `evidence_analysis_jobs`;--> statement-breakpoint
DROP TABLE `evidence_analysis_jobs`;--> statement-breakpoint
ALTER TABLE `__new_evidence_analysis_jobs` RENAME TO `evidence_analysis_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_analysis_jobs_input_version` ON `evidence_analysis_jobs` (`bundle_id`,`input_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_analysis_jobs_id_bundle` ON `evidence_analysis_jobs` (`id`,`bundle_id`);--> statement-breakpoint
CREATE TABLE `__new_evidence_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`input_version` text NOT NULL,
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
	CONSTRAINT "ck_evidence_chunks_exactly_one_provenance" CHECK((`source_id` IS NULL) != (`video_clip_id` IS NULL))
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_evidence_sources_block_cited_delete`;--> statement-breakpoint
INSERT INTO `__new_evidence_chunks`("id","bundle_id","input_version","source_id","video_clip_id","ordinal","location_label","content","content_hash","created_at")
SELECT chunk."id",chunk."bundle_id",COALESCE(
	(SELECT job."input_version" FROM `tactic_card_citations` AS citation
		JOIN `tactic_cards` AS card ON card."id"=citation."card_id"
		JOIN `evidence_analysis_jobs` AS job ON job."id"=card."job_id"
		WHERE citation."chunk_id"=chunk."id" LIMIT 1),
	(SELECT bundle."content_version" FROM `evidence_bundles` AS bundle WHERE bundle."id"=chunk."bundle_id")
),chunk."source_id",chunk."video_clip_id",chunk."ordinal",chunk."location_label",chunk."content",chunk."content_hash",chunk."created_at"
FROM `evidence_chunks` AS chunk;--> statement-breakpoint
DROP TABLE `evidence_chunks`;--> statement-breakpoint
ALTER TABLE `__new_evidence_chunks` RENAME TO `evidence_chunks`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_chunks_id_bundle` ON `evidence_chunks` (`id`,`bundle_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_chunks_source_input_ordinal` ON `evidence_chunks` (`bundle_id`,`input_version`,`source_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_chunks_clip_input_ordinal` ON `evidence_chunks` (`bundle_id`,`input_version`,`video_clip_id`,`ordinal`);--> statement-breakpoint
CREATE TRIGGER `trg_evidence_sources_block_cited_delete`
BEFORE DELETE ON `evidence_sources`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `evidence_chunks` AS `chunk`
	INNER JOIN `tactic_card_citations` AS `citation` ON `citation`.`chunk_id` = `chunk`.`id`
	WHERE `chunk`.`source_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, '연결된 카드가 있어 근거를 삭제할 수 없습니다.');
END;--> statement-breakpoint
PRAGMA foreign_keys=ON;
