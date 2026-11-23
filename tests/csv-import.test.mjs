import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The import route bundles with the real SQLite driver and migrations; auth, env and
// the personal-identity lookup are mocked — the lookup doubles as the per-row
// failure hook (boom@example.com throws, which the batch must absorb as `failed`).
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.csvImpEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.csvImpUser}",
	"@/lib/profile/sync": `
		export async function getPersonalIdentityForAddress(db, userId, email) {
			if (email === "boom@example.com") throw new Error("identity lookup failed");
			return null;
		}
		export async function syncPersonalIdentity() {}
	`,
};
const { app, newDatabase } = await loadApp("csv-import", `
	export { POST } from "./src/app/api/import/contacts/route.ts";
	export { parseCsvContacts, CSV_IMPORT_MAX_ROWS } from "./src/lib/import/csv.ts";
	export { decodeTextBytes } from "./src/lib/import/text.ts";
`, { mocks });
const { POST, parseCsvContacts, CSV_IMPORT_MAX_ROWS, decodeTextBytes } = app;

const seed = `${sharedMailboxSeed("full_access")}
	INSERT INTO contacts (id, user_id, email, display_name, source, blocked, created_at) VALUES
		('c-1', 'admin', 'existing@example.com', 'Old Name', 'manual', 0, 1);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
async function setup(t, who) {
	const { env, sqlite } = await newDatabase(t, seed);
	globalThis.csvImpEnv = env;
	globalThis.csvImpUser = user(who);
	return sqlite;
}
function post(mailboxId, content, filename = "contacts.csv", fields = {}) {
	const form = new FormData();
	if (mailboxId) form.set("mailboxId", mailboxId);
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	if (content !== null) form.set("file", new File([content], filename, { type: "text/csv" }));
	return new Request("http://localhost/api/import/contacts", { method: "POST", body: form });
}
const csv = (...lines) => `${lines.join("\r\n")}\r\n`;
const contactsOf = (sqlite, userId) => sqlite.prepare("SELECT email, display_name, source FROM contacts WHERE user_id = ? ORDER BY email").all(userId);

// ---------------------------------------------------------------- parser ---

test("the export's own column order round-trips, header included, blocked ignored", () => {
	// contactsToCsv writes name,email,blocked under a U+FEFF BOM.
	const { contacts, rows, skipped } = parseCsvContacts(`${String.fromCharCode(0xfeff)}name,email,blocked\r\nMaya Smith,maya@example.com,false\r\n,noname@example.com,true\r\n`);
	assert.deepEqual(contacts, [
		{ email: "maya@example.com", displayName: "Maya Smith" },
		{ email: "noname@example.com", displayName: undefined },
	]);
	assert.deepEqual(rows.map((row) => [row.row, row.status]), [[2, "ok"], [3, "ok"]]);
	assert.equal(skipped, 0);
});

test("a file without a header reads name,email positionally", () => {
	const { contacts } = parseCsvContacts(csv("Maya Smith,maya@example.com", "Other,other@example.com"));
	assert.deepEqual(contacts, [
		{ email: "maya@example.com", displayName: "Maya Smith" },
		{ email: "other@example.com", displayName: "Other" },
	]);
});

test("a single-column file is a bare address list", () => {
	const { contacts } = parseCsvContacts(csv("a@example.com", "b@example.com"));
	assert.deepEqual(contacts, [
		{ email: "a@example.com", displayName: undefined },
		{ email: "b@example.com", displayName: undefined },
	]);
});

test("quoted fields keep commas, doubled quotes and embedded line breaks", () => {
	const { contacts } = parseCsvContacts('name,email\n"Doe, ""JD""\nLine 2",jd@example.com\nPlain,plain@example.com');
	assert.deepEqual(contacts, [
		{ email: "jd@example.com", displayName: 'Doe, "JD"\nLine 2' },
		{ email: "plain@example.com", displayName: "Plain" },
	]);
});

test("CRLF, LF and CR endings all split records, and blank lines are ignored", () => {
	const { contacts } = parseCsvContacts("a@example.com\r\n\r\nb@example.com\nc@example.com\rd@example.com\r\n");
	assert.deepEqual(contacts.map((c) => c.email), ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
});

test("Google and Outlook style headers bind columns by name", () => {
	const { contacts } = parseCsvContacts(csv("Notes,E-mail 1 - Value,Name", "met at conf,g@example.com,Goog", "x,o@example.com,Out"));
	assert.deepEqual(contacts, [
		{ email: "g@example.com", displayName: "Goog" },
		{ email: "o@example.com", displayName: "Out" },
	]);
});

test("a header naming only a name column leaves every row without an email", () => {
	const { contacts, rows } = parseCsvContacts(csv("Name,Phone", "Maya,123"));
	assert.equal(contacts.length, 0);
	assert.deepEqual(rows.map((row) => row.status), ["invalid"]);
});

test("rows without a usable email are invalid, repeats are dup, the first wins", () => {
	const { contacts, rows } = parseCsvContacts(csv(
		"First,dup@example.com",
		"Second,DUP@example.com",
		"Nobody,no-email",
		"Third,dup@example.com",
	));
	assert.deepEqual(contacts, [{ email: "dup@example.com", displayName: "First" }]);
	assert.deepEqual(rows.map((row) => row.status), ["ok", "dup", "invalid", "dup"]);
	// The invalid row echoes its raw cell so a preview can show what was there.
	assert.equal(rows[2].email, "no-email");
});

test("the row cap classifies the first batch and counts the rest as skipped", () => {
	const { contacts, rows, skipped } = parseCsvContacts(csv("a@example.com", "b@example.com", "c@example.com"), 2);
	assert.equal(contacts.length, 2);
	assert.equal(rows.length, 2);
	assert.equal(skipped, 1);
});

test("names longer than the API's 100-char bound are truncated", () => {
	const { contacts } = parseCsvContacts(csv(`${"x".repeat(150)},a@example.com`));
	assert.equal(contacts[0].displayName.length, 100);
});

test("a UTF-8 BOM and a UTF-16 file both parse", () => {
	assert.equal(parseCsvContacts(`${String.fromCharCode(0xfeff)}a@example.com\n`).contacts[0].email, "a@example.com");
	const utf16 = Buffer.from("José,jose@example.com\n", "utf16le");
	const { contacts } = parseCsvContacts(decodeTextBytes(new Uint8Array([0xff, 0xfe, ...utf16]).buffer));
	assert.deepEqual(contacts, [{ email: "jose@example.com", displayName: "José" }]);
});

// ------------------------------------------------------------------ route ---

test("a .csv upload imports new rows, updates existing, and reports bad rows", async (t) => {
	const sqlite = await setup(t, "admin");
	const response = await POST(post("mb-admin", csv(
		"name,email,blocked",
		"Maya Smith,maya@example.com,false",
		"Renamed,existing@example.com,true",
		"Dup,maya@example.com,false",
		"Bad,junk,false",
	)));
	assert.equal(response.status, 200);
	// dup + invalid land in skipped, same counters a .vcf uses.
	assert.deepEqual(await response.json(), { imported: 1, updated: 1, skipped: 2, failed: 0 });
	assert.deepEqual(contactsOf(sqlite, "admin"), [
		{ email: "existing@example.com", display_name: "Renamed", source: "manual" },
		{ email: "maya@example.com", display_name: "Maya Smith", source: "manual" },
	]);
});

test("the explicit format field wins over the filename sniff", async (t) => {
	const sqlite = await setup(t, "admin");
	// A .txt upload declared as csv still parses; a declared vcf of csv content finds no cards.
	const csvResponse = await POST(post("mb-admin", "a@example.com\n", "list.txt", { format: "csv" }));
	assert.deepEqual(await csvResponse.json(), { imported: 1, updated: 0, skipped: 0, failed: 0 });
	assert.equal(contactsOf(sqlite, "admin").length, 2);

	const vcfResponse = await POST(post("mb-admin", "a2@example.com\n", "list.txt", { format: "vcf" }));
	assert.deepEqual(await vcfResponse.json(), { imported: 0, updated: 0, skipped: 0, failed: 0 });
});

test("an unknown format or conflict policy is a 400", async (t) => {
	await setup(t, "admin");
	assert.equal((await POST(post("mb-admin", "a@example.com\n", "c.csv", { format: "xml" }))).status, 400);
	assert.equal((await POST(post("mb-admin", "a@example.com\n", "c.csv", { conflict: "merge" }))).status, 400);
});

test("conflict=skip leaves existing contacts alone and counts them skipped", async (t) => {
	const sqlite = await setup(t, "admin");
	const response = await POST(post("mb-admin", csv(
		"New Name,existing@example.com",
		"Fresh,fresh@example.com",
	), "c.csv", { conflict: "skip" }));
	assert.deepEqual(await response.json(), { imported: 1, updated: 0, skipped: 1, failed: 0 });
	// The seeded contact keeps its stored name — the file's name is not written.
	assert.deepEqual(contactsOf(sqlite, "admin"), [
		{ email: "existing@example.com", display_name: "Old Name", source: "manual" },
		{ email: "fresh@example.com", display_name: "Fresh", source: "manual" },
	]);
});

test("the default conflict policy updates the stored name like POST /api/contacts", async (t) => {
	const sqlite = await setup(t, "admin");
	const response = await POST(post("mb-admin", "New Name,existing@example.com\n"));
	assert.deepEqual(await response.json(), { imported: 0, updated: 1, skipped: 0, failed: 0 });
	assert.equal(contactsOf(sqlite, "admin")[0].display_name, "New Name");
});

test("a row without a name updates the row but keeps the stored name", async (t) => {
	const sqlite = await setup(t, "admin");
	const response = await POST(post("mb-admin", ",existing@example.com\n"));
	assert.deepEqual(await response.json(), { imported: 0, updated: 1, skipped: 0, failed: 0 });
	assert.equal(contactsOf(sqlite, "admin")[0].display_name, "Old Name");
});

test("a preview classifies every row and writes nothing", async (t) => {
	const sqlite = await setup(t, "admin");
	const response = await POST(post("mb-admin", csv(
		"name,email",
		"Maya,maya@example.com",
		"Old,existing@example.com",
		"Again,maya@example.com",
		"Bad,junk",
	), "c.csv", { preview: "1" }));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.preview, true);
	assert.deepEqual(body.counts, { new: 1, existing: 1, invalid: 1, duplicates: 1, skipped: 0 });
	assert.deepEqual(body.rows, [
		{ row: 2, email: "maya@example.com", name: "Maya", status: "new" },
		{ row: 3, email: "existing@example.com", name: "Old", status: "existing" },
		{ row: 4, email: "maya@example.com", name: "Again", status: "dup" },
		{ row: 5, email: "junk", name: null, status: "invalid" },
	]);
	// Nothing was written: only the seeded contact remains, untouched.
	assert.deepEqual(contactsOf(sqlite, "admin"), [{ email: "existing@example.com", display_name: "Old Name", source: "manual" }]);
});

test("a .vcf preview reports new and existing cards without writing", async (t) => {
	const sqlite = await setup(t, "admin");
	const vcf = "BEGIN:VCARD\r\nFN:Maya\r\nEMAIL:maya@example.com\r\nEND:VCARD\r\nBEGIN:VCARD\r\nEMAIL:existing@example.com\r\nEND:VCARD\r\n";
	const response = await POST(post("mb-admin", vcf, "contacts.vcf", { preview: "1" }));
	const body = await response.json();
	assert.deepEqual(body.counts, { new: 1, existing: 1, invalid: 0, duplicates: 0, skipped: 0 });
	assert.deepEqual(body.rows, [
		{ row: 1, email: "maya@example.com", name: "Maya", status: "new" },
		{ row: 2, email: "existing@example.com", name: null, status: "existing" },
	]);
	assert.equal(contactsOf(sqlite, "admin").length, 1);
});

test("a delegate imports CSV into the shared mailbox owner's address book", async (t) => {
	const sqlite = await setup(t, "delegate");
	const response = await POST(post("mb-team", "Mate,mate@example.com\n"));
	assert.deepEqual(await response.json(), { imported: 1, updated: 0, skipped: 0, failed: 0 });
	const mate = contactsOf(sqlite, "admin").find((row) => row.email === "mate@example.com");
	assert.equal(mate.display_name, "Mate");
	assert.equal(contactsOf(sqlite, "delegate").length, 0);
});

test("a row that throws mid-write counts as failed without aborting the batch", async (t) => {
	await setup(t, "admin");
	const response = await POST(post("mb-admin", csv("Boom,boom@example.com", "Fine,fine@example.com")));
	assert.deepEqual(await response.json(), { imported: 1, updated: 0, skipped: 0, failed: 1 });
});

test("files over the row cap import the first batch and count the rest as skipped", async (t) => {
	await setup(t, "admin");
	const lines = Array.from({ length: CSV_IMPORT_MAX_ROWS + 2 }, (_, i) => `u${i}@example.com`);
	const response = await POST(post("mb-admin", `${lines.join("\n")}\n`));
	const body = await response.json();
	assert.equal(body.imported, CSV_IMPORT_MAX_ROWS);
	assert.equal(body.skipped, 2);
});

test("missing mailbox, missing or empty file are still 400s", async (t) => {
	await setup(t, "admin");
	assert.equal((await POST(post(null, "a@example.com\n"))).status, 400);
	assert.equal((await POST(post("mb-admin", null))).status, 400);
	assert.equal((await POST(post("mb-admin", ""))).status, 400);
});

test("mailboxes the user cannot manage return 404 for CSV too", async (t) => {
	await setup(t, "author"); // send_on_behalf on mb-team: below full_access, so not canManage
	assert.equal((await POST(post("mb-team", "a@example.com\n"))).status, 404);
	assert.equal((await POST(post("mb-nope", "a@example.com\n"))).status, 404);
});

test("an oversized CSV upload returns 413", async (t) => {
	await setup(t, "admin");
	const response = await POST(post("mb-admin", `a@example.com\n${"x".repeat(5 * 1024 * 1024)}`));
	assert.equal(response.status, 413);
});
