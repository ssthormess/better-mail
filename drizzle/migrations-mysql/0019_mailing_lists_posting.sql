ALTER TABLE `mailing_lists` ADD `posting_policy` varchar(64) NOT NULL DEFAULT 'members_only';--> statement-breakpoint
ALTER TABLE `mailing_lists` ADD `moderated` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `mailing_list_members` ADD `moderated` boolean NOT NULL DEFAULT false;