CREATE TABLE `__new_evidence_r2_cleanup_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`source_id` text NOT NULL,
	`storage_key` text,
	`extracted_text_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_evidence_r2_cleanup_receipts`("id", "bundle_id", "source_id", "storage_key", "extracted_text_key", "status", "error_message", "created_at", "updated_at") SELECT "id", "bundle_id", "source_id", "storage_key", "extracted_text_key", "status", "error_message", "created_at", "updated_at" FROM `evidence_r2_cleanup_receipts`;--> statement-breakpoint
DROP TABLE `evidence_r2_cleanup_receipts`;--> statement-breakpoint
ALTER TABLE `__new_evidence_r2_cleanup_receipts` RENAME TO `evidence_r2_cleanup_receipts`;--> statement-breakpoint
CREATE INDEX `idx_evidence_r2_cleanup_status` ON `evidence_r2_cleanup_receipts` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_evidence_r2_cleanup_bundle` ON `evidence_r2_cleanup_receipts` (`bundle_id`);
