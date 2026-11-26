-- The extraction sweep (src/lib/email/attachment-sweep.ts) reads the oldest rows
-- still waiting for text, so this index serves its status filter and its order.
CREATE INDEX `message_attachments_extract_status_idx` ON `message_attachments` (`extract_status`,`created_at`);--> statement-breakpoint
-- Full-text search over attachment text, mirroring messages_fts: an
-- external-content FTS5 index reads its text from message_attachments, so the
-- extracted text is not stored twice, and triggers keep it in step with every
-- insert, update and delete, whichever code path writes.
--
-- Only rows that reached `extract_status = 'done'` are indexed: "none" rows have
-- not been read yet, "failed" and "skipped" rows have nothing to search. A
-- "done" row with no text (an image-only PDF, a whitespace-only file) has no
-- posting at all.
--
-- SQLite only. PostgreSQL and MySQL search message columns directly and get
-- their attachment parity in a later change (F53).
CREATE VIRTUAL TABLE `attachments_fts` USING fts5(
	`extracted_text`,
	content='message_attachments',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `attachments_fts_ai` AFTER INSERT ON `message_attachments`
WHEN new.`extract_status` = 'done' AND new.`extracted_text` IS NOT NULL BEGIN
	INSERT INTO `attachments_fts`(`rowid`, `extracted_text`) VALUES (new.`rowid`, new.`extracted_text`);
END;--> statement-breakpoint
CREATE TRIGGER `attachments_fts_ad` AFTER DELETE ON `message_attachments`
WHEN old.`extract_status` = 'done' AND old.`extracted_text` IS NOT NULL BEGIN
	INSERT INTO `attachments_fts`(`attachments_fts`, `rowid`, `extracted_text`) VALUES ('delete', old.`rowid`, old.`extracted_text`);
END;--> statement-breakpoint
-- Delete then insert, like messages_fts_au, but each half is conditional: deletes are
-- only issued for rows that were indexed, because an FTS5 'delete' for a row that was
-- never inserted corrupts the index.
CREATE TRIGGER `attachments_fts_au` AFTER UPDATE OF `extracted_text`, `extract_status` ON `message_attachments` BEGIN
	INSERT INTO `attachments_fts`(`attachments_fts`, `rowid`, `extracted_text`)
		SELECT 'delete', old.`rowid`, old.`extracted_text`
		WHERE old.`extract_status` = 'done' AND old.`extracted_text` IS NOT NULL;
	INSERT INTO `attachments_fts`(`rowid`, `extracted_text`)
		SELECT new.`rowid`, new.`extracted_text`
		WHERE new.`extract_status` = 'done' AND new.`extracted_text` IS NOT NULL;
END;--> statement-breakpoint
-- Fills the index from the rows that already exist. A rebuild copies the content
-- column of every row, so it relies on the writer's contract that extracted_text is
-- only ever non-null on a "done" row.
INSERT INTO `attachments_fts`(`attachments_fts`) VALUES ('rebuild');
