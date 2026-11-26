-- The extraction sweep (src/lib/email/attachment-sweep.ts) reads the oldest rows
-- still waiting for text, so this index serves its status filter and its order.
CREATE INDEX `message_attachments_extract_status_idx` ON `message_attachments` (`extract_status`,`created_at`);--> statement-breakpoint
-- The rows attachment search is allowed to see: extracted, non-empty text.
--
-- This view, not `message_attachments`, is the FTS5 external content. Both the
-- `rebuild` command and a query on the index read the content table, and a rebuild
-- copies every row the content yields. Pointing content at the whole table indexed
-- rows the triggers deliberately skip (extract_status 'none'/'skipped'/'failed' or a
-- NULL text): a rebuild then produced postings the triggers would not remove on
-- delete — orphans — and, for a pending row with no text, a zero-token docsize entry
-- that also outlived the row. With the view, rebuild, the triggers and search agree
-- on one eligible set.
CREATE VIEW `attachments_fts_source` AS
SELECT `rowid` AS `rowid`, `extracted_text` AS `extracted_text`
FROM `message_attachments`
WHERE `extract_status` = 'done' AND `extracted_text` IS NOT NULL;--> statement-breakpoint
-- Full-text search over attachment text, mirroring messages_fts: an
-- external-content FTS5 index reads its text through the view above, so the
-- extracted text is not stored twice, and triggers keep it in step with every
-- insert, update and delete, whichever code path writes.
--
-- Only rows that reached `extract_status = 'done'` with text are indexed: "none"
-- rows have not been read yet, "failed" and "skipped" rows have nothing to search.
-- A "done" row with no text (an image-only PDF, a whitespace-only file) has no
-- posting at all.
--
-- SQLite only. PostgreSQL and MySQL search message columns directly and get
-- their attachment parity in a later change (F53).
CREATE VIRTUAL TABLE `attachments_fts` USING fts5(
	`extracted_text`,
	content='attachments_fts_source',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
-- The triggers never rely on the content lookup: they pass the rowid and text
-- explicitly, so they work for the exact old and new state of the row.
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
-- Fills the index from the rows that already exist. A rebuild copies what the content
-- yields, and the content is the eligible-rows view, so this indexes exactly the rows
-- the triggers would have indexed and nothing else.
INSERT INTO `attachments_fts`(`attachments_fts`) VALUES ('rebuild');
