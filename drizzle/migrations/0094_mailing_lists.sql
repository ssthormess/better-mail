CREATE TABLE `mailing_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mailing_list_members` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `mailing_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailing_lists_address_idx` ON `mailing_lists` (`domain_id`,`local_part`);
--> statement-breakpoint
CREATE INDEX `mailing_lists_user_idx` ON `mailing_lists` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailing_list_members_list_email_idx` ON `mailing_list_members` (`list_id`,`email`);
--> statement-breakpoint
CREATE INDEX `mailing_list_members_list_idx` ON `mailing_list_members` (`list_id`);
