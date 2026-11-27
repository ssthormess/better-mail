-- The index now covers `search_text`, the normalized token stream every dialect's
-- attachment index shares (F53 gate round 1; see drizzle/migrations/0117 and
-- src/lib/search/normalize.ts). PostgreSQL's 'simple' dictionary does not fold
-- accents and keeps an email or URL as one token, so raw extracted_text tokenized
-- differently than SQLite's unicode61 or MySQL's FULLTEXT saw it; on the normalized
-- stream only plain words remain and no tokenizer can disagree.
-- The stream is written app-side with extracted_text and backfilled for older rows
-- (index-admin.ts); NULL means "not normalized yet" and the partial index's new
-- predicate mirrors that.
ALTER TABLE "message_attachments" ADD "search_text" text;--> statement-breakpoint
DROP INDEX IF EXISTS "message_attachments_extracted_text_fts_idx";--> statement-breakpoint
CREATE INDEX "message_attachments_extracted_text_fts_idx" ON "message_attachments" USING gin ((to_tsvector('simple', "search_text"))) WHERE "extract_status" = 'done' AND "search_text" IS NOT NULL;
