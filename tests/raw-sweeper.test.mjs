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

test("completed pending deletes recover without issuing a second late object-store delete", async (t) => {
	const { env, sqlite } = await newDatabase(t);
	const database = env.DB;
	// The D1 binding surface only: prepare/batch, no interactive transaction, so the sweeper takes the
	// trigger/marker path.
	env.DB = {
		prepare: query => database.prepare(query),
		batch: statements => database.batch(statements),
	};
	const now = new Date("2027-01-02T00:00:00Z");
	const key = "inbound/recovery";
	let exists = true;
	let objectDeletes = 0;
	env.BUCKET = {
		list: async options => options.prefix === "inbound/" && exists
			? { objects: [{ key, uploaded: new Date(now.getTime() - 25 * 60 * 60 * 1000) }], truncated: false }
			: { objects: [], truncated: false },
		delete: async () => { objectDeletes++; exists = false; },
	};
	assert.equal(await app.sweepOrphanedRawMail(env, now), 1);
	assert.equal(sqlite.prepare("SELECT delete_complete FROM raw_sweep_pending_deletes WHERE raw_r2_key = ?").get(key).delete_complete, 1,
		"the completed marker is retained so a racing intake insert aborts instead of committing dangling");
	assert.equal(await app.sweepOrphanedRawMail(env, new Date(now.getTime() + 2 * 60 * 60 * 1000)), 0);
	assert.equal(objectDeletes, 1, "recovery only clears a durably completed claim; it never replays DELETE");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM raw_sweep_pending_deletes").get().n, 0);
});

test("a stale never-completed claim is released so its orphan is reclaimed and its intake unblocked", async (t) => {
	const { env, sqlite } = await newDatabase(t);
	const database = env.DB;
	env.DB = {
		prepare: query => database.prepare(query),
		batch: statements => database.batch(statements),
	};
	const now = new Date("2027-01-02T00:00:00Z");
	const key = "inbound/stale-claim";
	const objects = new Map([[key, new Uint8Array([7])]]);
	env.BUCKET = {
		get: async objectKey => (objects.has(objectKey) ? { arrayBuffer: async () => objects.get(objectKey).buffer } : null),
		put: async (objectKey, value) => { objects.set(objectKey, value instanceof ArrayBuffer ? new Uint8Array(value) : value); },
		delete: async objectKey => { objects.delete(objectKey); },
		list: async ({ prefix, cursor, limit }) => {
			const keys = [...objects.keys()].filter(objectKey => objectKey.startsWith(prefix)).sort();
			const start = cursor === undefined ? 0 : Math.max(0, keys.findIndex(objectKey => objectKey > cursor));
			const page = keys.slice(start, start + limit);
			const truncated = start + page.length < keys.length;
			return { objects: page.map(objectKey => ({ key: objectKey, uploaded: new Date(now.getTime() - 25 * 60 * 60 * 1000) })), truncated, cursor: truncated ? page.at(-1) : undefined };
		},
	};
	// Worker died between the claim and recording completion: an unfinished marker persisted.
	sqlite.prepare("INSERT INTO raw_sweep_pending_deletes (raw_r2_key, claim_token, claimed_at, delete_complete) VALUES (?, 'dead', ?, 0)")
		.run(key, Math.floor(new Date("2027-01-01T00:00:00Z").getTime() / 1000));
	// Same invocation: recovery releases the stale claim and the pass reclaims the orphan itself.
	assert.equal(await app.sweepOrphanedRawMail(env, now), 1);
	assert.equal(objects.has(key), false);
	// The reclaim's own completed marker is retained until the next recovery clears it.
	assert.equal(sqlite.prepare("SELECT delete_complete FROM raw_sweep_pending_deletes WHERE raw_r2_key = ?").get(key).delete_complete, 1);
	assert.equal(await app.sweepOrphanedRawMail(env, new Date(now.getTime() + 2 * 60 * 60 * 1000)), 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM raw_sweep_pending_deletes").get().n, 0);
});

test("a stale claim over an already-deleted object is released without an extra delete", async (t) => {
	const { env, sqlite } = await newDatabase(t);
	const database = env.DB;
	env.DB = {
		prepare: query => database.prepare(query),
		batch: statements => database.batch(statements),
	};
	const now = new Date("2027-01-02T00:00:00Z");
	let objectDeletes = 0;
	env.BUCKET = {
		get: async () => null,
		list: async () => ({ objects: [], truncated: false }),
		delete: async () => { objectDeletes++; },
	};
	sqlite.prepare("INSERT INTO raw_sweep_pending_deletes (raw_r2_key, claim_token, claimed_at, delete_complete) VALUES ('inbound/gone', 'dead', ?, 0)")
		.run(Math.floor(new Date("2027-01-01T00:00:00Z").getTime() / 1000));
	assert.equal(await app.sweepOrphanedRawMail(env, now), 0);
	assert.equal(objectDeletes, 0, "recovery releases the marker; it never retries the delete");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM raw_sweep_pending_deletes").get().n, 0);
});

test("an invalid stored raw listing cursor is reset and the scan restarts", async (t) => {
	const { env, sqlite } = await newDatabase(t);
	sqlite.prepare("UPDATE app_settings SET raw_mail_sweep_cursor = 'invalid-continuation' WHERE id = 'default'").run();
	const now = new Date("2027-01-02T00:00:00Z");
	const key = "inbound/orphan";
	const calls = [];
	const deleted = [];
	env.BUCKET = {
		list: async options => {
			if (options.prefix === "inbound/") {
				calls.push(options.cursor ?? null);
				if (options.cursor) throw Object.assign(new Error("Invalid continuation token"), { name: "InvalidArgument" });
				return { objects: [{ key, uploaded: new Date(now.getTime() - 25 * 60 * 60 * 1000) }], truncated: false };
			}
			return { objects: [], truncated: false };
		},
		delete: async objectKey => deleted.push(objectKey),
	};
	assert.equal(await app.sweepOrphanedRawMail(env, now), 1);
	assert.deepEqual(calls, ["invalid-continuation", null]);
	assert.deepEqual(deleted, [key]);
	assert.equal(sqlite.prepare("SELECT raw_mail_sweep_cursor FROM app_settings WHERE id = 'default'").get().raw_mail_sweep_cursor, null);
});
