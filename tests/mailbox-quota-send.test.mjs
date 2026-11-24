import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// MAILBOX_STORAGE_LIMIT_BYTES is enforced inside sendEmail, the funnel every send
// path goes through: /api/send, /api/v1/send and JMAP EmailSubmission/set. These
// tests run that funnel end to end, plus the two error surfaces it feeds — the
// HTTP layer (413 + code) and the JMAP notCreated entry.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.quotaEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.quotaUser}",
};
const { app, newDatabase } = await loadApp("mailbox-quota-send", `
	export { sendEmail } from "./src/lib/email/send.ts";
	export { checkMailboxQuota, estimateOutgoingBytes, getMailboxStorageLimit, MailboxStorageQuotaError } from "./src/lib/email/mailbox-quota.ts";
	export { emailSubmissionSet } from "./src/lib/jmap/identities.ts";
	export { identityId } from "./src/lib/jmap/ids.ts";
	export * as sendApi from "./src/app/api/send/route.ts";
`, { mocks });

const SEED = `
	INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
		('u1', 'me@example.com', 'hash', 'Me', 'admin', 1, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES
		('d1', 'u1', 'example.com', 'zone-1', 'active', 'cloudflare', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
		('mb1', 'u1', 'd1', 'me', 'personal', 1);
`;

function envFor(base, limit) {
	return {
		...base,
		EMAIL: { send: async () => ({ messageId: "<sent@example.com>" }) },
		BUCKET: { put: async () => ({}), get: async () => null, delete: async () => {} },
		OUTBOUND_QUEUE: { send: async () => {} },
		...(limit === undefined ? {} : { MAILBOX_STORAGE_LIMIT_BYTES: String(limit) }),
	};
}

const countRows = (sqlite) => Object.fromEntries(
	["messages", "message_attachments", "outbound_jobs", "contacts"].map(
		(table) => [table, sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get().c],
	),
);

// usage already on the mailbox: one stored inbound message whose body is `bytes` octets.
const seedMessage = (id, bytes) => `
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, text_body, status, created_at)
	VALUES ('${id}', 'u1', 'mb1', 'inbound', 'a@x.test', 'me@example.com', '${"x".repeat(bytes)}', 'received', 1);
`;

const sendInput = (overrides = {}) => ({
	userId: "u1",
	from: "me@example.com",
	to: "you@x.test",
	subject: "s",
	text: "hello",
	mailboxId: "mb1",
	...overrides,
});

test("estimateOutgoingBytes counts UTF-8 octets plus attachment bytes", () => {
	assert.equal(app.estimateOutgoingBytes({}), 0);
	// 'héllo' is 6 octets, not 5 — the estimate must agree with getMailboxUsage's octet basis.
	assert.equal(app.estimateOutgoingBytes({ text: "héllo", html: "<p>x</p>" }), 14);
	assert.equal(
		app.estimateOutgoingBytes({ text: "ab", attachments: [{ filename: "a", type: "t", content: new Uint8Array(10).buffer }] }),
		12,
	);
});

test("getMailboxStorageLimit treats unset, garbled and non-positive values as unlimited", () => {
	assert.equal(app.getMailboxStorageLimit({}), null);
	assert.equal(app.getMailboxStorageLimit({ MAILBOX_STORAGE_LIMIT_BYTES: "0" }), null);
	assert.equal(app.getMailboxStorageLimit({ MAILBOX_STORAGE_LIMIT_BYTES: "-10" }), null);
	assert.equal(app.getMailboxStorageLimit({ MAILBOX_STORAGE_LIMIT_BYTES: "junk" }), null);
	assert.equal(app.getMailboxStorageLimit({ MAILBOX_STORAGE_LIMIT_BYTES: "1000" }), 1000);
	assert.equal(app.getMailboxStorageLimit({ MAILBOX_STORAGE_LIMIT_BYTES: "1048576.9" }), 1048576);
});

test("an over-limit send is refused before any row is written", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED + seedMessage("m-old", 900));
	const before = countRows(sqlite);
	const error = await app
		.sendEmail(envFor(env, 1000), sendInput({ text: "y".repeat(101) }))
		.then(() => null, (err) => err);
	assert.ok(error instanceof app.MailboxStorageQuotaError);
	assert.equal(error.code, "MAILBOX_STORAGE_QUOTA_EXCEEDED");
	assert.match(error.message, /^Mailbox storage quota exceeded/);
	assert.deepEqual(countRows(sqlite), before, "no message, attachment, job or contact rows on a refused send");
});

test("attachment bytes count toward the same cap", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED + seedMessage("m-old", 900));
	const before = countRows(sqlite);
	const error = await app
		.sendEmail(envFor(env, 1000), sendInput({
			text: "y".repeat(50),
			attachments: [{ filename: "a.bin", type: "application/octet-stream", content: new Uint8Array(51).buffer }],
		}))
		.then(() => null, (err) => err);
	assert.ok(error instanceof app.MailboxStorageQuotaError);
	assert.deepEqual(countRows(sqlite), before);
});

test("a send landing exactly on the cap is allowed and delivered", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED + seedMessage("m-old", 900));
	// 900 used + 50 text + 50 attachment = 1000 == limit: the check rejects only above it.
	const result = await app.sendEmail(envFor(env, 1000), sendInput({
		text: "y".repeat(50),
		attachments: [{ filename: "a.bin", type: "application/octet-stream", content: new Uint8Array(50).buffer }],
	}));
	assert.ok(result.messageId);
	const row = sqlite.prepare("SELECT status, mailbox_id FROM messages WHERE id = ?").get(result.messageId);
	assert.equal(row.status, "sent");
	assert.equal(row.mailbox_id, "mb1");
	assert.equal(sqlite.prepare("SELECT count(*) AS c FROM message_attachments WHERE message_id = ?").get(result.messageId).c, 1);
	assert.equal(sqlite.prepare("SELECT status FROM outbound_jobs WHERE message_id = ?").get(result.messageId).status, "sent");
});

test("no variable configured means unlimited", async (t) => {
	const { env } = await newDatabase(t, SEED + seedMessage("m-old", 900));
	const result = await app.sendEmail(envFor(env, undefined), sendInput({ text: "y".repeat(10_000) }));
	assert.ok(result.messageId);
});

test("a garbled limit does not break sending", async (t) => {
	const { env } = await newDatabase(t, SEED + seedMessage("m-old", 900));
	const result = await app.sendEmail(envFor(env, "not-a-number"), sendInput({ text: "y".repeat(10_000) }));
	assert.ok(result.messageId);
});

test("the send API answers 413 with the quota code and stores nothing", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED + seedMessage("m-old", 900));
	globalThis.quotaEnv = envFor(env, 1000);
	globalThis.quotaUser = { id: "u1", role: "admin", isPrimaryAdmin: true, canManageUsers: false };
	const before = countRows(sqlite);
	const response = await app.sendApi.POST(new Request("http://localhost/api/send", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ from: "me@example.com", to: "you@x.test", subject: "s", text: "y".repeat(101), mailboxId: "mb1" }),
	}));
	assert.equal(response.status, 413);
	const body = await response.json();
	assert.equal(body.code, "MAILBOX_STORAGE_QUOTA_EXCEEDED");
	assert.match(body.error, /^Mailbox storage quota exceeded/);
	assert.deepEqual(countRows(sqlite), before);
});

test("JMAP EmailSubmission/set hits the same gate and keeps the draft", async (t) => {
	// The draft's own stored body already counts toward usage; with the 500-byte
	// old message it holds 600 of the 650-byte cap, and its 100-byte send would land at 700.
	const { env, sqlite } = await newDatabase(t, SEED + seedMessage("m-old", 500) + `
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('draft1', 'u1', 'mb1', 'outbound', 'me@example.com', 'you@x.test', 's', '${"d".repeat(100)}', 'draft', 1);
	`);
	const fullEnv = envFor(env, 650);
	const ctx = {
		env: fullEnv,
		db: app.getDb(fullEnv),
		auth: { userId: "u1", email: "me@example.com", scopes: ["jmap"], mailboxIds: null, user: { id: "u1", email: "me@example.com", role: "admin" } },
		accountId: "u1",
		origin: "http://test",
		createdIds: {},
		memo: {},
	};
	const before = countRows(sqlite);
	const result = await app.emailSubmissionSet(ctx, {
		create: { c1: { emailId: "draft1", identityId: app.identityId("mb1", "me@example.com") } },
	});
	assert.equal(result.notCreated.c1.type, "forbidden");
	assert.match(result.notCreated.c1.description, /^Mailbox storage quota exceeded/);
	assert.deepEqual(countRows(sqlite), before, "the draft and all other rows survive a refused submission");
});
