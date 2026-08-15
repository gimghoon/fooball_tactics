CREATE TABLE `attempts` (
	`event_id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`scenario_id` text NOT NULL,
	`principle` text NOT NULL,
	`correct` integer NOT NULL,
	`touch_x` integer NOT NULL,
	`touch_y` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_attempts_participant` ON `attempts` (`participant_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`formation` text NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`source_title` text,
	`source_url` text,
	`reviewed_at` integer
);
--> statement-breakpoint
INSERT OR IGNORE INTO `campaigns` (`id`, `title`, `formation`, `review_status`, `source_title`)
VALUES ('diamond-121-intro', '다이아몬드 1-2-1 입문', '1-2-1', 'pending', '사용자 제공 코치 자료 대기');
--> statement-breakpoint
CREATE TABLE `mastery` (
	`participant_id` text NOT NULL,
	`principle` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mastery_participant_principle` ON `mastery` (`participant_id`,`principle`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`nickname` text NOT NULL,
	`token_hash` text NOT NULL,
	`is_owner` integer DEFAULT false NOT NULL,
	`completed_stage` text DEFAULT 'intro' NOT NULL,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_participants_room_nickname` ON `participants` (`room_id`,`nickname`);--> statement-breakpoint
CREATE TABLE `reflections` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`mission_id` text NOT NULL,
	`result` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_reflections_participant` ON `reflections` (`participant_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_code` text NOT NULL,
	`campaign_id` text NOT NULL,
	`owner_participant_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rooms_invite_code` ON `rooms` (`invite_code`);--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`role` text NOT NULL,
	`principle` text NOT NULL,
	`prompt` text NOT NULL,
	`hint` text NOT NULL,
	`explanation` text NOT NULL,
	`pitch_json` text NOT NULL,
	`answer_json` text NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`order_index` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scenarios_campaign_order` ON `scenarios` (`campaign_id`,`order_index`);
