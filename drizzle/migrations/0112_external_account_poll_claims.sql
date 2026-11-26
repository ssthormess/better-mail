ALTER TABLE `external_accounts` ADD `poll_claim_token` text;
--> statement-breakpoint
ALTER TABLE `external_accounts` ADD `poll_claim_until` integer;
--> statement-breakpoint
CREATE INDEX `external_accounts_claim_idx` ON `external_accounts` (`enabled`,`protocol`,`poll_claim_until`,`last_synced_at`);
