ALTER TABLE `attempts` ADD `action_type` text DEFAULT 'pass' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `target_player_id` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `path_json` text;--> statement-breakpoint
ALTER TABLE `scenarios` ADD `content_json` text DEFAULT '' NOT NULL;