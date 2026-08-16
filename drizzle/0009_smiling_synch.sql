CREATE TABLE `scenario_evidence_chunks` (
	`scenario_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	PRIMARY KEY(`scenario_id`, `chunk_id`),
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chunk_id`) REFERENCES `evidence_chunks`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_scenario_evidence_chunks_chunk` ON `scenario_evidence_chunks` (`chunk_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tactic_card_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`status` text NOT NULL,
	`version_kind` text DEFAULT 'status_change' NOT NULL,
	`producer_job_id` text,
	`producer_model` text,
	`content_json` text NOT NULL,
	`citation_snapshot_json` text NOT NULL,
	`bundle_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `tactic_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_tactic_card_reviews_status" CHECK("__new_tactic_card_reviews"."status" IN ('analysis_draft', 'owner_reviewed', 'coach_reviewed', 'held', 'rejected')),
	CONSTRAINT "ck_tactic_card_reviews_version_kind" CHECK("__new_tactic_card_reviews"."version_kind" IN ('llm_draft', 'owner_edit', 'coach_edit', 'status_change'))
);
--> statement-breakpoint
INSERT INTO `__new_tactic_card_reviews`("id", "card_id", "actor_user_id", "status", "version_kind", "producer_job_id", "producer_model", "content_json", "citation_snapshot_json", "bundle_version", "created_at") SELECT "id", "card_id", "actor_user_id", "status", 'status_change', NULL, NULL, "content_json", "citation_snapshot_json", "bundle_version", "created_at" FROM `tactic_card_reviews`;--> statement-breakpoint
DROP TABLE `tactic_card_reviews`;--> statement-breakpoint
ALTER TABLE `__new_tactic_card_reviews` RENAME TO `tactic_card_reviews`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tactic_card_reviews_one_llm_draft` ON `tactic_card_reviews` (`card_id`) WHERE "tactic_card_reviews"."version_kind" = 'llm_draft';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tactic_card_reviews_id_card` ON `tactic_card_reviews` (`id`,`card_id`);--> statement-breakpoint
ALTER TABLE `tactic_cards` ADD `current_review_id` text;--> statement-breakpoint
UPDATE `tactic_cards`
SET `current_review_id`=(
	SELECT `review`.`id`
	FROM `tactic_card_reviews` AS `review`
	WHERE `review`.`card_id`=`tactic_cards`.`id`
		AND `review`.`status`=`tactic_cards`.`status`
		AND `review`.`content_json`=`tactic_cards`.`current_content_json`
		AND `review`.`bundle_version`=`tactic_cards`.`bundle_version`
	ORDER BY `review`.`created_at` DESC, `review`.`id` DESC
	LIMIT 1
);--> statement-breakpoint
INSERT OR IGNORE INTO `scenario_evidence_chunks` (`scenario_id`,`chunk_id`)
SELECT `provenance`.`scenario_id`,`chunk`.`id`
FROM `scenario_tactic_card_reviews` AS `provenance`
INNER JOIN `tactic_card_reviews` AS `review` ON `review`.`id`=`provenance`.`card_review_id`
INNER JOIN json_each(
	CASE WHEN json_valid(`review`.`citation_snapshot_json`) THEN `review`.`citation_snapshot_json` ELSE '[]' END
) AS `citation`
INNER JOIN `evidence_chunks` AS `chunk` ON `chunk`.`id`=json_extract(`citation`.`value`,'$.chunkId');--> statement-breakpoint
INSERT OR IGNORE INTO `scenario_evidence_sources` (`scenario_id`,`source_id`)
SELECT `relation`.`scenario_id`,`chunk`.`source_id`
FROM `scenario_evidence_chunks` AS `relation`
INNER JOIN `evidence_chunks` AS `chunk` ON `chunk`.`id`=`relation`.`chunk_id`
WHERE `chunk`.`source_id` IS NOT NULL;
