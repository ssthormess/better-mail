CREATE TABLE "mailing_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"local_part" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailing_list_members" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailing_lists" ADD CONSTRAINT "mailing_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailing_lists" ADD CONSTRAINT "mailing_lists_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailing_list_members" ADD CONSTRAINT "mailing_list_members_list_id_mailing_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."mailing_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailing_lists_address_idx" ON "mailing_lists" USING btree ("domain_id","local_part");--> statement-breakpoint
CREATE INDEX "mailing_lists_user_idx" ON "mailing_lists" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailing_list_members_list_email_idx" ON "mailing_list_members" USING btree ("list_id","email");--> statement-breakpoint
CREATE INDEX "mailing_list_members_list_idx" ON "mailing_list_members" USING btree ("list_id");