-- Attachment text is searchable on MySQL too (F53): a FULLTEXT index on extracted_text,
-- matched with boolean-mode AGAINST queries built in conditions.ts (+a* / +"a b" for the
-- positive terms, bare words for the ORed negation). MySQL has no partial indexes, so the
-- index covers every row and the query's WHERE — extract_status = 'done' AND
-- extracted_text IS NOT NULL — keeps the eligible set identical to the SQLite FTS5
-- source view (drizzle/migrations/0109) and the partial GIN index (migrations-pg/0041).
-- InnoDB notes: tokens shorter than innodb_ft_min_token_size (default 3) and stopwords
-- are not indexed, so a prefix term under 3 letters cannot match — unlike unicode61,
-- which indexes every token length.
CREATE FULLTEXT INDEX `message_attachments_extracted_text_fts_idx` ON `message_attachments` (`extracted_text`);
