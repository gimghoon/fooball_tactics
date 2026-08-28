ALTER TABLE `evidence_search_candidates` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `evidence_search_candidates` ADD `lease_expires_at` integer;--> statement-breakpoint
CREATE INDEX `idx_search_candidate_run_recovery` ON `evidence_search_candidates` (`run_id`,`status`,`lease_expires_at`);--> statement-breakpoint
ALTER TABLE `evidence_search_runs` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `evidence_search_runs` ADD `lease_expires_at` integer;--> statement-breakpoint
CREATE INDEX `idx_evidence_search_runs_recovery` ON `evidence_search_runs` (`status`,`lease_expires_at`);