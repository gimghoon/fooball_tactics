CREATE TABLE `evidence_r2_cleanup_receipts` (
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
CREATE INDEX `idx_evidence_r2_cleanup_status` ON `evidence_r2_cleanup_receipts` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_evidence_r2_cleanup_bundle` ON `evidence_r2_cleanup_receipts` (`bundle_id`);
