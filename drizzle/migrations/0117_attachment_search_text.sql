-- What every dialect's attachment-text index is fed instead of raw `extracted_text`
-- (F53 gate round 1): the normalized token stream of src/lib/search/normalize.ts —
-- lower-case, accent-folded, punctuation split, and tokens no stock InnoDB index
-- could keep (under 3 characters, stopwords, over 84) dropped. With the same stream
-- on all three engines, a query cannot tokenize differently per dialect.
--
-- The stream is written app-side wherever extracted_text is written
-- (attachment-text.ts) and backfilled for older rows (index-admin.ts via the
-- extraction sweep): no engine can compute it, accent folding is not portable
-- SQL. NULL means "not normalized yet" — such a row is invisible to attachment
-- search until the backfill reaches it, exactly like a 'none' row is until
-- extraction does.
ALTER TABLE `message_attachments` ADD `search_text` text;--> statement-breakpoint
-- The FTS5 external content now yields the normalized stream, so the eligible set
-- becomes `extract_status = 'done' AND search_text IS NOT NULL` — the same set the
-- PostgreSQL partial index and the MySQL query predicate enforce.
DROP VIEW IF EXISTS `attachments_fts_source`;--> statement-breakpoint
CREATE VIEW `attachments_fts_source` AS
SELECT `rowid` AS `rowid`, `search_text` AS `extracted_text`
FROM `message_attachments`
WHERE `extract_status` = 'done' AND `search_text` IS NOT NULL;--> statement-breakpoint
-- The index itself: recreated here as IF NOT EXISTS so a database that never
-- applied 0109 reaches the same state in one step (the deployment window of
-- docs/deployment.md leaves pending migrations pending, not skipped).
CREATE VIRTUAL TABLE IF NOT EXISTS `attachments_fts` USING fts5(
	`extracted_text`,
	content='attachments_fts_source',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
-- Same trigger shapes as 0109, re-pointed at `search_text`. `au` now also watches
-- `search_text`, which is how a backfilled row acquires its posting.
DROP TRIGGER IF EXISTS `attachments_fts_ai`;--> statement-breakpoint
CREATE TRIGGER `attachments_fts_ai` AFTER INSERT ON `message_attachments`
WHEN new.`extract_status` = 'done' AND new.`search_text` IS NOT NULL BEGIN
	INSERT INTO `attachments_fts`(`rowid`, `extracted_text`) VALUES (new.`rowid`, new.`search_text`);
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `attachments_fts_ad`;--> statement-breakpoint
CREATE TRIGGER `attachments_fts_ad` AFTER DELETE ON `message_attachments`
WHEN old.`extract_status` = 'done' AND old.`search_text` IS NOT NULL BEGIN
	INSERT INTO `attachments_fts`(`attachments_fts`, `rowid`, `extracted_text`) VALUES ('delete', old.`rowid`, old.`search_text`);
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `attachments_fts_au`;--> statement-breakpoint
CREATE TRIGGER `attachments_fts_au` AFTER UPDATE OF `extract_status`, `search_text` ON `message_attachments` BEGIN
	INSERT INTO `attachments_fts`(`attachments_fts`, `rowid`, `extracted_text`)
		SELECT 'delete', old.`rowid`, old.`search_text`
		WHERE old.`extract_status` = 'done' AND old.`search_text` IS NOT NULL;
	INSERT INTO `attachments_fts`(`rowid`, `extracted_text`)
		SELECT new.`rowid`, new.`search_text`
		WHERE new.`extract_status` = 'done' AND new.`search_text` IS NOT NULL;
END;--> statement-breakpoint
-- Repopulate from the new source: clears the postings the old extracted_text-based
-- view produced and re-reads what the new content yields. Rows without a stream
-- yet contribute nothing and gain their posting through the `au` trigger when the
-- backfill writes `search_text`.
INSERT INTO `attachments_fts`(`attachments_fts`) VALUES ('rebuild');
