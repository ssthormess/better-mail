CREATE TABLE `mailing_lists` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`domain_id` varchar(191) NOT NULL,
	`local_part` varchar(191) NOT NULL,
	`name` longtext NOT NULL,
	`description` longtext,
	`disabled` boolean NOT NULL DEFAULT false,
	`created_at` bigint NOT NULL,
	CONSTRAINT `mailing_lists_id` PRIMARY KEY(`id`),
	CONSTRAINT `mailing_lists_address_idx` UNIQUE(`domain_id`,`local_part`)
);
--> statement-breakpoint
CREATE TABLE `mailing_list_members` (
	`id` varchar(191) NOT NULL,
	`list_id` varchar(191) NOT NULL,
	`email` varchar(320) NOT NULL,
	`name` longtext,
	`role` varchar(64) NOT NULL DEFAULT 'member',
	`created_at` bigint NOT NULL,
	CONSTRAINT `mailing_list_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `mailing_list_members_list_email_idx` UNIQUE(`list_id`,`email`)
);
--> statement-breakpoint
ALTER TABLE `mailing_lists` ADD CONSTRAINT `mailing_lists_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mailing_lists` ADD CONSTRAINT `mailing_lists_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mailing_list_members` ADD CONSTRAINT `mailing_list_members_list_id_mailing_lists_id_fk` FOREIGN KEY (`list_id`) REFERENCES `mailing_lists`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mailing_lists_user_idx` ON `mailing_lists` (`user_id`);--> statement-breakpoint
CREATE INDEX `mailing_list_members_list_idx` ON `mailing_list_members` (`list_id`);