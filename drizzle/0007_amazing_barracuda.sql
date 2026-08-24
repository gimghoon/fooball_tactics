PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__task6_durable_cards` (`card_id` text PRIMARY KEY NOT NULL,`job_id` text NOT NULL);--> statement-breakpoint
INSERT INTO `__task6_durable_cards` (`card_id`,`job_id`)
SELECT card.`id`,card.`job_id` FROM `tactic_cards` AS card
WHERE card.`status` IN ('owner_reviewed','coach_reviewed','held','rejected')
	OR EXISTS (
		SELECT 1 FROM `tactic_card_reviews` AS review
		WHERE review.`card_id`=card.`id`
			AND review.`status` IN ('owner_reviewed','coach_reviewed','held','rejected')
	);--> statement-breakpoint
CREATE TABLE `__task6_jobs_with_durable_cards` (`job_id` text PRIMARY KEY NOT NULL);--> statement-breakpoint
INSERT INTO `__task6_jobs_with_durable_cards` (`job_id`)
SELECT DISTINCT `job_id` FROM `__task6_durable_cards`;--> statement-breakpoint
CREATE TABLE `__task6_jobs_with_quarantined_drafts` (`job_id` text PRIMARY KEY NOT NULL);--> statement-breakpoint
INSERT INTO `__task6_jobs_with_quarantined_drafts` (`job_id`)
SELECT DISTINCT `job_id` FROM `tactic_cards` WHERE `status`='analysis_draft';--> statement-breakpoint
UPDATE `tactic_cards`
SET `status`='held',`is_stale`=1
WHERE `status`='analysis_draft';--> statement-breakpoint
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

INSERT INTO `__new_evidence_analysis_jobs`("id", "bundle_id", "input_version", "status", "analyzer_model", "prompt_version", "schema_version", "stage", "lease_owner", "lease_token", "lease_expires_at", "error_message", "started_at", "completed_at", "attempt_count", "extracted_evidence_json", "generated_cards_json", "is_stale", "created_at", "updated_at") SELECT "id", "bundle_id", "input_version", CASE
	WHEN EXISTS (SELECT 1 FROM `__task6_jobs_with_durable_cards` WHERE `job_id`=`evidence_analysis_jobs`.`id`)
		THEN CASE WHEN "status"='completed' THEN 'completed' ELSE 'review_ready' END
	WHEN EXISTS (SELECT 1 FROM `__task6_jobs_with_quarantined_drafts` WHERE `job_id`=`evidence_analysis_jobs`.`id`) THEN 'queued'
	WHEN "stage" IN ('chunks_ready','extract_evidence','evidence_extracted','generate_cards','cards_generated','persist_cards','cards_persisted') THEN 'queued'
	ELSE "status"
END, "analyzer_model", "prompt_version", "schema_version", CASE
	WHEN EXISTS (SELECT 1 FROM `__task6_jobs_with_durable_cards` WHERE `job_id`=`evidence_analysis_jobs`.`id`) THEN 'done'
	WHEN EXISTS (SELECT 1 FROM `__task6_jobs_with_quarantined_drafts` WHERE `job_id`=`evidence_analysis_jobs`.`id`) THEN 'extract_evidence'
	WHEN "stage"='queued' THEN 'validate_sources'
	WHEN "stage"='validate_sources' THEN 'validate_sources'
	WHEN "stage"='sources_validated' THEN 'extract_text'
	WHEN "stage"='extract_text' THEN 'extract_text'
	WHEN "stage"='text_extracted' THEN 'normalize_clips'
	WHEN "stage"='normalize_clips' THEN 'normalize_clips'
	WHEN "stage"='chunks_ready' THEN 'extract_evidence'
	WHEN "stage"='extract_evidence' THEN 'extract_evidence'
	WHEN "stage"='evidence_extracted' THEN 'extract_evidence'
	WHEN "stage"='generate_cards' THEN 'extract_evidence'
	WHEN "stage"='cards_generated' THEN 'extract_evidence'
	WHEN "stage"='persist_cards' THEN 'extract_evidence'
	WHEN "stage"='cards_persisted' THEN 'extract_evidence'
	WHEN "stage"='done' THEN 'done'
	WHEN "stage"='completed' THEN 'done'
	ELSE 'validate_sources'
END, NULL, NULL, NULL,
CASE WHEN EXISTS (SELECT 1 FROM `__task6_jobs_with_quarantined_drafts` WHERE `job_id`=`evidence_analysis_jobs`.`id`)
	OR "stage" IN ('chunks_ready','extract_evidence','evidence_extracted','generate_cards','cards_generated','persist_cards','cards_persisted') THEN NULL ELSE "error_message" END,
"started_at",
CASE WHEN EXISTS (SELECT 1 FROM `__task6_jobs_with_quarantined_drafts` WHERE `job_id`=`evidence_analysis_jobs`.`id`)
	OR "stage" IN ('chunks_ready','extract_evidence','evidence_extracted','generate_cards','cards_generated','persist_cards','cards_persisted') THEN NULL ELSE "completed_at" END,
0, NULL, NULL, "is_stale", "created_at", "updated_at" FROM `evidence_analysis_jobs`;--> statement-breakpoint
DROP TABLE `evidence_analysis_jobs`;--> statement-breakpoint
ALTER TABLE `__new_evidence_analysis_jobs` RENAME TO `evidence_analysis_jobs`;--> statement-breakpoint
DROP TABLE `__task6_jobs_with_durable_cards`;--> statement-breakpoint
DROP TABLE `__task6_jobs_with_quarantined_drafts`;--> statement-breakpoint
DROP TABLE `__task6_durable_cards`;--> statement-breakpoint
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
CREATE TABLE `__task6_chunk_versions` (
	`old_chunk_id` text NOT NULL,
	`input_version` text NOT NULL,
	`new_chunk_id` text NOT NULL,
	PRIMARY KEY (`old_chunk_id`,`input_version`)
);--> statement-breakpoint
INSERT OR IGNORE INTO `__task6_chunk_versions` (`old_chunk_id`,`input_version`,`new_chunk_id`)
SELECT chunk.`id`,card.`bundle_version`,chunk.`id` || ':task6:' || length(card.`bundle_version`) || ':' || card.`bundle_version`
FROM `evidence_chunks` AS chunk
INNER JOIN `tactic_card_citations` AS citation ON citation.`chunk_id`=chunk.`id`
INNER JOIN `tactic_cards` AS card ON card.`id`=citation.`card_id`;--> statement-breakpoint
INSERT OR IGNORE INTO `__task6_chunk_versions` (`old_chunk_id`,`input_version`,`new_chunk_id`)
SELECT chunk.`id`,bundle.`content_version`,chunk.`id` || ':task6:' || length(bundle.`content_version`) || ':' || bundle.`content_version`
FROM `evidence_chunks` AS chunk
INNER JOIN `evidence_bundles` AS bundle ON bundle.`id`=chunk.`bundle_id`;--> statement-breakpoint
INSERT OR IGNORE INTO `__task6_chunk_versions` (`old_chunk_id`,`input_version`,`new_chunk_id`)
SELECT chunk.`id`,card.`bundle_version`,chunk.`id` || ':task6:' || length(card.`bundle_version`) || ':' || card.`bundle_version`
FROM `evidence_chunks` AS chunk
CROSS JOIN `tactic_cards` AS card
WHERE instr(card.`draft_content_json`,'"' || chunk.`id` || '"')>0
	OR instr(card.`current_content_json`,'"' || chunk.`id` || '"')>0;--> statement-breakpoint
INSERT OR IGNORE INTO `__task6_chunk_versions` (`old_chunk_id`,`input_version`,`new_chunk_id`)
SELECT chunk.`id`,review.`bundle_version`,chunk.`id` || ':task6:' || length(review.`bundle_version`) || ':' || review.`bundle_version`
FROM `evidence_chunks` AS chunk
CROSS JOIN `tactic_card_reviews` AS review
WHERE instr(review.`content_json`,'"' || chunk.`id` || '"')>0
	OR instr(review.`citation_snapshot_json`,'"' || chunk.`id` || '"')>0;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_evidence_sources_block_cited_delete`;--> statement-breakpoint
INSERT INTO `__new_evidence_chunks`("id","bundle_id","input_version","source_id","video_clip_id","ordinal","location_label","content","content_hash","created_at")
SELECT mapping."new_chunk_id",chunk."bundle_id",mapping."input_version",chunk."source_id",chunk."video_clip_id",
	chunk."ordinal",chunk."location_label",chunk."content",chunk."content_hash",chunk."created_at"
FROM `evidence_chunks` AS chunk
INNER JOIN `__task6_chunk_versions` AS mapping ON mapping."old_chunk_id"=chunk."id";--> statement-breakpoint
WITH RECURSIVE `replacements` AS (
	SELECT card.`id` AS `card_id`,mapping.`old_chunk_id`,mapping.`new_chunk_id`,
		ROW_NUMBER() OVER (PARTITION BY card.`id` ORDER BY mapping.`old_chunk_id`) AS `ordinal`
	FROM `tactic_cards` AS card
	INNER JOIN `__task6_chunk_versions` AS mapping
		ON mapping.`input_version`=card.`bundle_version`
	WHERE instr(card.`draft_content_json`,'"' || mapping.`old_chunk_id` || '"')>0
		OR instr(card.`current_content_json`,'"' || mapping.`old_chunk_id` || '"')>0
), `rewritten`(`card_id`,`ordinal`,`draft_json`,`current_json`) AS (
	SELECT card.`id`,0,card.`draft_content_json`,card.`current_content_json` FROM `tactic_cards` AS card
	UNION ALL
	SELECT rewritten.`card_id`,rewritten.`ordinal`+1,
		replace(rewritten.`draft_json`,'"' || replacement.`old_chunk_id` || '"','"' || replacement.`new_chunk_id` || '"'),
		replace(rewritten.`current_json`,'"' || replacement.`old_chunk_id` || '"','"' || replacement.`new_chunk_id` || '"')
	FROM `rewritten` AS rewritten
	INNER JOIN `replacements` AS replacement
		ON replacement.`card_id`=rewritten.`card_id` AND replacement.`ordinal`=rewritten.`ordinal`+1
)
UPDATE `tactic_cards` SET
	`draft_content_json`=(SELECT rewritten.`draft_json` FROM `rewritten` WHERE rewritten.`card_id`=`tactic_cards`.`id` ORDER BY rewritten.`ordinal` DESC LIMIT 1),
	`current_content_json`=(SELECT rewritten.`current_json` FROM `rewritten` WHERE rewritten.`card_id`=`tactic_cards`.`id` ORDER BY rewritten.`ordinal` DESC LIMIT 1);--> statement-breakpoint
WITH RECURSIVE `replacements` AS (
	SELECT review.`id` AS `review_id`,mapping.`old_chunk_id`,mapping.`new_chunk_id`,
		ROW_NUMBER() OVER (PARTITION BY review.`id` ORDER BY mapping.`old_chunk_id`) AS `ordinal`
	FROM `tactic_card_reviews` AS review
	INNER JOIN `__task6_chunk_versions` AS mapping
		ON mapping.`input_version`=review.`bundle_version`
	WHERE instr(review.`content_json`,'"' || mapping.`old_chunk_id` || '"')>0
		OR instr(review.`citation_snapshot_json`,'"' || mapping.`old_chunk_id` || '"')>0
), `rewritten`(`review_id`,`ordinal`,`content_json`,`snapshot_json`) AS (
	SELECT review.`id`,0,review.`content_json`,review.`citation_snapshot_json` FROM `tactic_card_reviews` AS review
	UNION ALL
	SELECT rewritten.`review_id`,rewritten.`ordinal`+1,
		replace(rewritten.`content_json`,'"' || replacement.`old_chunk_id` || '"','"' || replacement.`new_chunk_id` || '"'),
		replace(rewritten.`snapshot_json`,'"' || replacement.`old_chunk_id` || '"','"' || replacement.`new_chunk_id` || '"')
	FROM `rewritten` AS rewritten
	INNER JOIN `replacements` AS replacement
		ON replacement.`review_id`=rewritten.`review_id` AND replacement.`ordinal`=rewritten.`ordinal`+1
)
UPDATE `tactic_card_reviews` SET
	`content_json`=(SELECT rewritten.`content_json` FROM `rewritten` WHERE rewritten.`review_id`=`tactic_card_reviews`.`id` ORDER BY rewritten.`ordinal` DESC LIMIT 1),
	`citation_snapshot_json`=(SELECT rewritten.`snapshot_json` FROM `rewritten` WHERE rewritten.`review_id`=`tactic_card_reviews`.`id` ORDER BY rewritten.`ordinal` DESC LIMIT 1);--> statement-breakpoint
CREATE TABLE `__task6_tactic_card_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`card_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__task6_tactic_card_citations` (`id`,`bundle_id`,`card_id`,`chunk_id`,`created_at`)
SELECT `id`,`bundle_id`,`card_id`,`chunk_id`,`created_at` FROM `tactic_card_citations`;--> statement-breakpoint
DROP TABLE `tactic_card_citations`;--> statement-breakpoint
DROP TABLE `evidence_chunks`;--> statement-breakpoint
ALTER TABLE `__new_evidence_chunks` RENAME TO `evidence_chunks`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_chunks_id_bundle` ON `evidence_chunks` (`id`,`bundle_id`);--> statement-breakpoint
CREATE TABLE `tactic_card_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`card_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`,`bundle_id`) REFERENCES `tactic_cards`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chunk_id`,`bundle_id`) REFERENCES `evidence_chunks`(`id`,`bundle_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `tactic_card_citations` (`id`,`bundle_id`,`card_id`,`chunk_id`,`created_at`)
SELECT citation.`id`,citation.`bundle_id`,citation.`card_id`,mapping.`new_chunk_id`,citation.`created_at`
FROM `__task6_tactic_card_citations` AS citation
INNER JOIN `tactic_cards` AS card ON card.`id`=citation.`card_id`
INNER JOIN `__task6_chunk_versions` AS mapping
	ON mapping.`old_chunk_id`=citation.`chunk_id` AND mapping.`input_version`=card.`bundle_version`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tactic_card_citations_card_chunk` ON `tactic_card_citations` (`card_id`,`chunk_id`);--> statement-breakpoint
DROP TABLE `__task6_tactic_card_citations`;--> statement-breakpoint
DROP TABLE `__task6_chunk_versions`;--> statement-breakpoint
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
