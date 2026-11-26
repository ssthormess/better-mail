CREATE TABLE "raw_sweep_pending_deletes" (
	"raw_r2_key" text PRIMARY KEY NOT NULL,
	"claim_token" text NOT NULL,
	"claimed_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "raw_mail_sweep_fence" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION raw_sweep_guard_message_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.raw_r2_key LIKE 'inbound/%' THEN
		UPDATE app_settings SET raw_mail_sweep_fence = raw_mail_sweep_fence + 1 WHERE id = 'default';
		IF EXISTS (SELECT 1 FROM raw_sweep_pending_deletes WHERE raw_r2_key = NEW.raw_r2_key) THEN
			RAISE EXCEPTION 'raw_sweep_in_progress';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER raw_sweep_messages_bi BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION raw_sweep_guard_message_reference();
--> statement-breakpoint
CREATE TRIGGER raw_sweep_messages_bu BEFORE UPDATE OF raw_r2_key ON messages FOR EACH ROW EXECUTE FUNCTION raw_sweep_guard_message_reference();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION raw_sweep_guard_pending_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE app_settings SET raw_mail_sweep_fence = raw_mail_sweep_fence + 1 WHERE id = 'default';
	IF EXISTS (SELECT 1 FROM messages WHERE raw_r2_key = NEW.raw_r2_key) THEN
		RAISE EXCEPTION 'raw_sweep_referenced';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER raw_sweep_pending_bi BEFORE INSERT ON raw_sweep_pending_deletes FOR EACH ROW EXECUTE FUNCTION raw_sweep_guard_pending_delete();