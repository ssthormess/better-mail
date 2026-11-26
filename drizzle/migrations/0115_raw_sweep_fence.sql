CREATE TABLE `raw_sweep_pending_deletes` (
	`raw_r2_key` text PRIMARY KEY NOT NULL,
	`claim_token` text NOT NULL,
	`claimed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `raw_mail_sweep_fence` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `raw_sweep_pending_bi` BEFORE INSERT ON `raw_sweep_pending_deletes` BEGIN
	UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default';
	SELECT CASE WHEN EXISTS (SELECT 1 FROM `messages` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN RAISE(ABORT, 'raw_sweep_referenced') END;
END;
--> statement-breakpoint
CREATE TRIGGER `raw_sweep_messages_bi` BEFORE INSERT ON `messages` WHEN NEW.`raw_r2_key` LIKE 'inbound/%' BEGIN
	UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default';
	SELECT CASE WHEN EXISTS (SELECT 1 FROM `raw_sweep_pending_deletes` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN RAISE(ABORT, 'raw_sweep_in_progress') END;
END;
--> statement-breakpoint
CREATE TRIGGER `raw_sweep_messages_bu` BEFORE UPDATE OF `raw_r2_key` ON `messages` WHEN NEW.`raw_r2_key` LIKE 'inbound/%' BEGIN
	UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default';
	SELECT CASE WHEN EXISTS (SELECT 1 FROM `raw_sweep_pending_deletes` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN RAISE(ABORT, 'raw_sweep_in_progress') END;
END;