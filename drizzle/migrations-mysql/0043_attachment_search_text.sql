-- Drop the r1 FULLTEXT index on raw `extracted_text`; 0044 recreates it on the
-- normalized `search_text` stream. Between this and 0044 the search probe sees no
-- index on search_text and attachment search degrades to message-only, so no
-- intermediate state can serve a query the index cannot answer.
DROP INDEX `message_attachments_extracted_text_fts_idx` ON `message_attachments`;
