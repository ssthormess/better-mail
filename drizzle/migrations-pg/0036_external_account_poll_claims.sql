ALTER TABLE "external_accounts" ADD COLUMN "poll_claim_token" text;
--> statement-breakpoint
ALTER TABLE "external_accounts" ADD COLUMN "poll_claim_until" bigint;
--> statement-breakpoint
CREATE INDEX "external_accounts_claim_idx" ON "external_accounts" USING btree ("enabled","protocol","poll_claim_until","last_synced_at");
