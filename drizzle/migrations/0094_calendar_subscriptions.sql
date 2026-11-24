CREATE TABLE `calendar_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`feed_url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`etag` text,
	`last_modified` text,
	`refresh_interval_sec` integer DEFAULT 3600 NOT NULL,
	`last_refresh_at` integer,
	`last_refresh_status` integer,
	`last_error` text,
	`event_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `subscription_id` text REFERENCES `calendar_subscriptions`(`id`) ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_subscriptions_user_url_idx` ON `calendar_subscriptions` (`user_id`,`feed_url`);
--> statement-breakpoint
CREATE INDEX `calendar_subscriptions_user_idx` ON `calendar_subscriptions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `calendar_subscriptions_refresh_idx` ON `calendar_subscriptions` (`last_refresh_at`);
--> statement-breakpoint
CREATE INDEX `calendar_events_subscription_idx` ON `calendar_events` (`subscription_id`);
