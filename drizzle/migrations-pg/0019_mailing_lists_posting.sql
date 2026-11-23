ALTER TABLE "mailing_lists" ADD COLUMN "posting_policy" text DEFAULT 'members_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailing_lists" ADD COLUMN "moderated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mailing_list_members" ADD COLUMN "moderated" boolean DEFAULT false NOT NULL;