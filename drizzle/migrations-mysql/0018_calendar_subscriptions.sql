CREATE TABLE `calendar_subscriptions` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`feed_url` varchar(512) NOT NULL,
	`title` longtext NOT NULL DEFAULT (''),
	`etag` longtext,
	`last_modified` longtext,
	`refresh_interval_sec` bigint NOT NULL DEFAULT 3600,
	`last_refresh_at` bigint,
	`last_refresh_status` bigint,
	`last_error` longtext,
	`event_count` bigint NOT NULL DEFAULT 0,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `calendar_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_subscriptions_user_url_idx` UNIQUE(`user_id`,`feed_url`)
);
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `subscription_id` varchar(191);--> statement-breakpoint
ALTER TABLE `calendar_subscriptions` ADD CONSTRAINT `calendar_subscriptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD CONSTRAINT `calendar_events_subscription_id_calendar_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `calendar_subscriptions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `calendar_subscriptions_user_idx` ON `calendar_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `calendar_subscriptions_refresh_idx` ON `calendar_subscriptions` (`last_refresh_at`);--> statement-breakpoint
CREATE INDEX `calendar_events_subscription_idx` ON `calendar_events` (`subscription_id`);
