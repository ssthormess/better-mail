CREATE TABLE `raw_sweep_pending_deletes` (
	`raw_r2_key` varchar(512) NOT NULL,
	`claim_token` longtext NOT NULL,
	`claimed_at` bigint NOT NULL,
	CONSTRAINT `raw_sweep_pending_deletes_raw_r2_key` PRIMARY KEY(`raw_r2_key`)
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `raw_mail_sweep_fence` bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `raw_sweep_pending_bi` BEFORE INSERT ON `raw_sweep_pending_deletes` FOR EACH ROW
BEGIN
	UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default';
	IF EXISTS (SELECT 1 FROM `messages` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'raw_sweep_referenced';
	END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `raw_sweep_messages_bi` BEFORE INSERT ON `messages` FOR EACH ROW
BEGIN
	IF NEW.`raw_r2_key` LIKE 'inbound/%' THEN
		UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default';
		IF EXISTS (SELECT 1 FROM `raw_sweep_pending_deletes` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'raw_sweep_in_progress';
		END IF;
	END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `raw_sweep_messages_bu` BEFORE UPDATE ON `messages` FOR EACH ROW
BEGIN
	IF NOT (NEW.`raw_r2_key` <=> OLD.`raw_r2_key`) AND NEW.`raw_r2_key` LIKE 'inbound/%' THEN
		UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default';
		IF EXISTS (SELECT 1 FROM `raw_sweep_pending_deletes` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'raw_sweep_in_progress';
		END IF;
	END IF;
END;