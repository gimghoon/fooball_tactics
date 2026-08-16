DROP TRIGGER IF EXISTS `trg_evidence_sources_block_linked_delete`;--> statement-breakpoint
CREATE TABLE `evidence_mutation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_mutation_receipts_bundle_source` ON `evidence_mutation_receipts` (`bundle_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `scenario_evidence_sources` (
	`scenario_id` text NOT NULL,
	`source_id` text NOT NULL,
	PRIMARY KEY(`scenario_id`, `source_id`),
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `evidence_sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_scenario_evidence_sources_source` ON `scenario_evidence_sources` (`source_id`);--> statement-breakpoint
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
END;
