CREATE TABLE `evidence_r2_cleanup_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`source_id` text NOT NULL,
	`storage_key` text,
	`extracted_text_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_r2_cleanup_status` ON `evidence_r2_cleanup_receipts` (`status`,`updated_at`);