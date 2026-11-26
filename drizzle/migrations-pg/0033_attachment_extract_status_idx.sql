CREATE INDEX "message_attachments_extract_status_idx" ON "message_attachments" USING btree ("extract_status","created_at");
