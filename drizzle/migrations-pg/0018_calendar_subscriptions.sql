CREATE TABLE "calendar_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"feed_url" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"etag" text,
	"last_modified" text,
	"refresh_interval_sec" bigint DEFAULT 3600 NOT NULL,
	"last_refresh_at" bigint,
	"last_refresh_status" bigint,
	"last_error" text,
	"event_count" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "calendar_subscriptions" ADD CONSTRAINT "calendar_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_subscription_id_calendar_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."calendar_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_subscriptions_user_url_idx" ON "calendar_subscriptions" USING btree ("user_id","feed_url");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_user_idx" ON "calendar_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_refresh_idx" ON "calendar_subscriptions" USING btree ("last_refresh_at");--> statement-breakpoint
CREATE INDEX "calendar_events_subscription_idx" ON "calendar_events" USING btree ("subscription_id");
