import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The export route bundles with the real SQLite driver and migrations; auth and env are mocked.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.csvEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.csvUser}",
};
const { app, newDatabase } = await loadApp("csv-export", `
	export { GET } from "./src/app/api/export/contacts/route.ts";
	export { contactsToCsv } from "./src/lib/export/csv.ts";
`, { mocks });
const { GET, contactsToCsv } = app;

const seed = `${sharedMailboxSeed("read_only")}
	INSERT INTO contacts (id, user_id, email, display_name, source, blocked, created_at) VALUES
		('c-1', 'admin', 'maya@example.com', 'Maya, Smith', 'manual', 0, 1),
		('c-2', 'admin', 'blocked@example.com', 'Spammy Sender', 'inbound', 1, 1),
		('c-3', 'admin', 'noname@example.com', NULL, 'inbound', 0, 1),
		('c-4', 'admin', 'unicode@example.com', 'José García 日本語', 'manual', 0, 1),
		('c-5', 'admin', 'unseen@example.com', 'Hidden', 'manual', 0, 1),
		('c-6', 'admin', 'evil@example.com', '=HYPERLINK("https://x")', 'inbound', 0, 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'maya@example.com', 'team@example.com', 'Hi', 'received', 1),
		('m-2', 'admin', 'mb-team', 'outbound', 'team@example.com', 'blocked@example.com, noname@example.com', 'Out', 'sent', 2),
		('m-3', 'admin', 'mb-team', 'inbound', 'unicode@example.com', 'team@example.com', 'Uni', 'received', 3),
		('m-4', 'admin', 'mb-team', 'inbound', 'evil@example.com', 'team@example.com', 'Evil', 'received', 4);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
const get = (path) => new Request(`http://localhost${path}`);
async function setup(t, who) {
	const { env } = await newDatabase(t, seed);
	globalThis.csvEnv = env;
	globalThis.csvUser = user(who);
}

// Minimal RFC 4180 reader for assertions: handles quoted fields, doubled
// quotes and CRLF rows, and strips the BOM so field names stay readable.
function parse(csv) {
	const text = csv.replace(/^\uFEFF/, "");
	const rows = [];
	let field = "", row = [], quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') { field += '"'; i++; }
				else quoted = false;
			} else field += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") { row.push(field); field = ""; }
		else if (char === "\r" && text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
		else field += char;
	}
	return rows;
}

test("fields with commas, quotes or line breaks are quoted per RFC 4180", () => {
	const [header, row] = parse(contactsToCsv([
		{ email: "a@example.com", displayName: 'Doe, "JD"\nLine 2', blocked: false },
	]));
	assert.deepEqual(header, ["name", "email", "blocked"]);
	assert.deepEqual(row, ['Doe, "JD"\nLine 2', "a@example.com", "false"]);
});

test("inner quotes are doubled inside a quoted field", () => {
	const csv = contactsToCsv([{ email: "a@example.com", displayName: 'Say "hi"', blocked: false }]);
	assert.match(csv, /"Say ""hi""",a@example\.com,false\r\n/);
});

test("every row ends CRLF and there are no bare line feeds", () => {
	const csv = contactsToCsv([
		{ email: "a@example.com", displayName: "A", blocked: false },
		{ email: "b@example.com", displayName: "B", blocked: true },
	]);
	assert.ok(csv.endsWith("\r\n"));
	assert.equal(csv.split("\n").length - 1, csv.split("\r\n").length - 1);
	assert.equal(parse(csv).length, 3);
});

test("a UTF-8 BOM leads the file so Excel reads unicode names", () => {
	const csv = contactsToCsv([{ email: "u@example.com", displayName: "José García 日本語", blocked: false }]);
	assert.equal(csv.charCodeAt(0), 0xfeff);
	assert.match(csv, /^\uFEFFname,email,blocked\r\n/);
	assert.match(csv, /José García 日本語/);
});

test("a contact without a name exports an empty first field", () => {
	const [, row] = parse(contactsToCsv([{ email: "noname@example.com", displayName: null, blocked: false }]));
	assert.deepEqual(row, ["", "noname@example.com", "false"]);
});

test("the blocked flag mirrors the vCard CATEGORIES marker as a true/false column", () => {
	const rows = parse(contactsToCsv([
		{ email: "b@example.com", displayName: "Spammer", blocked: true },
		{ email: "f@example.com", displayName: "Friend", blocked: false },
	]));
	assert.deepEqual(rows[1], ["Spammer", "b@example.com", "true"]);
	assert.deepEqual(rows[2], ["Friend", "f@example.com", "false"]);
});

test("cells that would run as spreadsheet formulas are prefixed with a quote", () => {
	for (const name of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", " =x", "\t=cmd|' /C calc'!A0"]) {
		const [, row] = parse(contactsToCsv([{ email: "a@example.com", displayName: name, blocked: false }]));
		assert.ok(row[0].startsWith("'"), `unguarded formula cell: ${JSON.stringify(name)} -> ${JSON.stringify(row[0])}`);
	}
	// Ordinary names, including ones with the trigger chars mid-string, are untouched.
	const [, ok] = parse(contactsToCsv([{ email: "a@example.com", displayName: "A - B = C", blocked: false }]));
	assert.equal(ok[0], "A - B = C");
});

test("a formula-looking name survives verbatim behind the ' marker", () => {
	const csv = contactsToCsv([{ email: "a@example.com", displayName: "+Anna", blocked: false }]);
	// Exact bytes: the marker is an unquoted leading ' and +Anna is preserved as-is.
	assert.ok(csv.endsWith("'+Anna,a@example.com,false\r\n"));
	const [, row] = parse(csv);
	assert.equal(row[0], "'+Anna");
});

test("the owner exports the whole address book as CSV, blocked contacts included", async (t) => {
	await setup(t, "admin");
	const response = await GET(get("/api/export/contacts?mailboxId=mb-team&format=csv"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Content-Type"), "text/csv; charset=utf-8");
	assert.match(response.headers.get("Content-Disposition") ?? "", /filename="contacts\.csv"/);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const rows = parse(await response.text());
	assert.deepEqual(rows[0], ["name", "email", "blocked"]);
	assert.equal(rows.length, 7);
	const emails = rows.slice(1).map((row) => row[1]).sort();
	assert.deepEqual(emails, [
		"blocked@example.com",
		"evil@example.com",
		"maya@example.com",
		"noname@example.com",
		"unicode@example.com",
		"unseen@example.com",
	]);
	const blocked = rows.find((row) => row[1] === "blocked@example.com");
	assert.equal(blocked[2], "true");
	const evil = rows.find((row) => row[1] === "evil@example.com");
	assert.ok(evil[0].startsWith("'"));
});

test("a shared-mailbox delegate exports only the contacts visible on its mail", async (t) => {
	await setup(t, "delegate");
	const response = await GET(get("/api/export/contacts?mailboxId=mb-team&format=csv"));
	assert.equal(response.status, 200);
	const rows = parse(await response.text());
	const emails = rows.slice(1).map((row) => row[1]);
	assert.equal(emails.length, 5);
	assert.ok(!emails.includes("unseen@example.com"));
	assert.ok(emails.includes("maya@example.com"));
	assert.ok(emails.includes("blocked@example.com"));
});

test("no format param still returns the vCard stream", async (t) => {
	await setup(t, "admin");
	const response = await GET(get("/api/export/contacts?mailboxId=mb-team"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Content-Type"), "text/vcard; charset=utf-8");
});

test("an unknown format returns 400, and so do the usual scoping failures", async (t) => {
	await setup(t, "delegate");
	assert.equal((await GET(get("/api/export/contacts?mailboxId=mb-team&format=xml"))).status, 400);
	assert.equal((await GET(get("/api/export/contacts"))).status, 400);
	assert.equal((await GET(get("/api/export/contacts?mailboxId=mb-admin&format=csv"))).status, 404);
});
