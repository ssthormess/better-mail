-- The normalized token stream every dialect's attachment index shares (F53 gate
-- round 1; see drizzle/migrations/0117 and src/lib/search/normalize.ts). Written
-- app-side with extracted_text and backfilled for older rows; NULL means
-- "not normalized yet".
--
-- One statement per file: MySQL commits DDL implicitly, and the migration runner
-- records the name only after the statements run, so a multi-statement file that
-- stops mid-way is retried from the top — this keeps every step re-runnable.
ALTER TABLE `message_attachments` ADD `search_text` text;
