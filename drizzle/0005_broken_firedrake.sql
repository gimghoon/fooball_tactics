ALTER TABLE `evidence_analysis_jobs` ADD `is_stale` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TRIGGER `trg_evidence_sources_block_linked_delete`
BEFORE DELETE ON `evidence_sources`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `evidence_chunks` AS `chunk`
	INNER JOIN `tactic_card_citations` AS `citation` ON `citation`.`chunk_id` = `chunk`.`id`
	WHERE `chunk`.`source_id` = OLD.`id`
) OR EXISTS (
	SELECT 1
	FROM `scenarios`
	WHERE `review_status` = 'draft'
		AND `content_json` LIKE '%' || OLD.`id` || '%'
)
BEGIN
	SELECT RAISE(ABORT, '연결된 카드 또는 시나리오 초안이 있어 근거를 삭제할 수 없습니다.');
END;
