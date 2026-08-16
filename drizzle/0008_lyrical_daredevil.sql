CREATE TABLE `scenario_tactic_card_reviews` (
	`scenario_id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`card_review_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_review_id`,`card_id`) REFERENCES `tactic_card_reviews`(`id`,`card_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scenario_tactic_card_reviews_review` ON `scenario_tactic_card_reviews` (`card_review_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tactic_card_reviews_id_card` ON `tactic_card_reviews` (`id`,`card_id`);