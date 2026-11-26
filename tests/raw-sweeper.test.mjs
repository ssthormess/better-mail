import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("raw-sweeper", `
	export { sweepOrphanedRawMail } from "./src/lib/email/raw-sweeper.ts";
`);

test("orphaned raw sweep resumes beyond 2,000 retained keys and resets for the next pass", async (t) => {
	const { env, sqlite } = await newDatabase(t, `
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u', 'u@example.test', 'hash', 'User', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'u', 'example.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m', 'u', 'd', 'user', 1);
	`);
	const now = new Date("2027-01-02T00:00:00Z");
	const uploaded = new Date(now.getTime() - 25 * 60 * 60 * 1000);
	const objects = new Map();
	const referenceInsert = sqlite.prepare(`INSERT INTO messages
		(id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, raw_r2_key, created_at)
		VALUES (?, 'u', 'm', 'inbound', 'sender@example.test', 'user@example.test', 'Retained', '', 'received', ?, 1)`);
	for (let index = 0; index < 2_000; index++) {
		const key = `inbound/${String(index).padStart(5, "0")}`;
		objects.set(key, { uploaded, body: new Uint8Array([index % 255]) });
		referenceInsert.run(`msg-${index}`, key);
	}
	const orphanKey = "inbound/02000-orphan";
	objects.set(orphanKey, { uploaded, body: new Uint8Array([255]) });
	const listCursors = [];
	const deleted = [];
	env.BUCKET = {
		list: async ({ prefix, cursor, limit }) => {
			if (prefix === "inbound/") listCursors.push(cursor ?? null);
			const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
			const start = cursor === undefined ? 0 : keys.findIndex(key => key > cursor);
			const offset = start < 0 ? keys.length : start;
			const page = keys.slice(offset, offset + limit);
			const truncated = offset + page.length < keys.length;
			return { objects: page.map(key => ({ key, uploaded: objects.get(key).uploaded })), truncated, cursor: truncated ? page.at(-1) : undefined };
		},
		delete: async keys => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				deleted.push(key);
				objects.delete(key);
			}
		},
	};

	assert.equal(await app.sweepOrphanedRawMail(env, now), 0);
	assert.equal(listCursors[0], null);
	assert.equal(sqlite.prepare("SELECT raw_mail_sweep_cursor FROM app_settings WHERE id = 'default'").get().raw_mail_sweep_cursor, "inbound/01999");

	// A fresh invocation recovers its continuation from app_settings instead of starting over.
	assert.equal(await app.sweepOrphanedRawMail(env, now), 1);
	assert.equal(listCursors[20], "inbound/01999");
	assert.equal(objects.has(orphanKey), false);
	assert.deepEqual(deleted, [orphanKey]);
	assert.equal(sqlite.prepare("SELECT raw_mail_sweep_cursor FROM app_settings WHERE id = 'default'").get().raw_mail_sweep_cursor, null, "a completed pass wraps to the start");

	assert.equal(await app.sweepOrphanedRawMail(env, now), 0);
	assert.equal(listCursors[21], null, "the next pass begins at the first key after wraparound");
	assert.equal(objects.size, 2_000, "all referenced raw objects remain protected");
});
