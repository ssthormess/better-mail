ALTER TABLE `external_accounts`
	ADD COLUMN `poll_claim_token` longtext,
	ADD COLUMN `poll_claim_until` bigint,
	ADD INDEX `external_accounts_claim_idx` (`enabled`,`protocol`,`poll_claim_until`,`last_synced_at`);
