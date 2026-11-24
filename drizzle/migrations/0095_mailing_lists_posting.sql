ALTER TABLE `mailing_lists` ADD `posting_policy` text DEFAULT 'members_only' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailing_lists` ADD `moderated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailing_list_members` ADD `moderated` integer DEFAULT false NOT NULL;