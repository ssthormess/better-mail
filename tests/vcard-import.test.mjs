import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The import route bundles with the real SQLite driver and migrations; auth, env and
// the personal-identity lookup are mocked — the lookup doubles as the per-card
// failure hook (boom@example.com throws, which the batch must absorb as `failed`).
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.vcfImpEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.vcfImpUser}",
	"@/lib/profile/sync": `
		export async function getPersonalIdentityForAddress(db, userId, email) {
			if (email === "boom@example.com") throw new Error("identity lookup failed");
			return null;
		}
		export async function syncPersonalIdentity() {}
	`,
};
const { app, newDatabase } = await loadApp("vcf-import", `
	export { POST } from "./src/app/api/import/contacts/route.ts";
	export { decodeVcfBytes, parseVcfContacts, VCARD_IMPORT_MAX_CARDS } from "./src/lib/import/vcard.ts";
`, { mocks });
const { POST, decodeVcfBytes, parseVcfContacts, VCARD_IMPORT_MAX_CARDS } = app;

const seed = `${sharedMailboxSeed("full_access")}
	INSERT INTO contacts (id, user_id, email, display_name, source, blocked, created_at) VALUES
		('c-1', 'admin', 'existing@example.com', 'Old Name', 'manual', 0, 1);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
async function setup(t, who) {
	const { env, sqlite } = await newDatabase(t, seed);
	globalThis.vcfImpEnv = env;
	globalThis.vcfImpUser = user(who);
	return sqlite;
}
function post(mailboxId, content, filename = "contacts.vcf") {
	const form = new FormData();
	if (mailboxId) form.set("mailboxId", mailboxId);
	if (content !== null) form.set("file", new File([content], filename, { type: "text/vcard" }));
	return new Request("http://localhost/api/import/contacts", { method: "POST", body: form });
}
const card = (...lines) => `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.join("\r\n")}\r\nEND:VCARD\r\n`;
const contactsOf = (sqlite, userId) => sqlite.prepare("SELECT email, display_name, source FROM contacts WHERE user_id = ? ORDER BY email").all(userId);

// ---------------------------------------------------------------- parser ---

test("a plain 3.0 file yields one contact per card", () => {
	const vcf = card("FN:Maya Smith", "EMAIL:maya@example.com") + card("N:Doe;John;;;", "EMAIL;TYPE=HOME:john@example.com");
	const { contacts, skipped } = parseVcfContacts(vcf);
	assert.equal(skipped, 0);
	assert.deepEqual(contacts, [
		{ email: "maya@example.com", displayName: "Maya Smith" },
		{ email: "john@example.com", displayName: undefined },
	]);
});

test("a line folded with a leading space joins back before decoding", () => {
	// The fold marker (CRLF + one space) is removed whole, so real exporters wrap mid-word.
	const { contacts } = parseVcfContacts(card("FN:A Very Long Name With A Long Su", " ffix", "EMAIL:a@example.com"));
	assert.equal(contacts[0].displayName, "A Very Long Name With A Long Suffix");
});

test("vCard 2.1 quoted-printable names decode through their charset", () => {
	const vcf = card("VERSION:2.1", "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 Garc=C3=ADa", "EMAIL;INTERNET:jose@example.com");
	assert.equal(parseVcfContacts(vcf).contacts[0].displayName, "José García");
});

test("a 2.1 quoted-printable value wrapped at '=' joins without losing characters", () => {
	// The soft break sits inside the =C3=A9 escape, the nastiest wrap a 2.1 exporter writes.
	const vcf = card(
		"VERSION:2.1",
		"FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Jos=C3=",
		"=A9",
		"EMAIL:jose@example.com",
	);
	assert.equal(parseVcfContacts(vcf).contacts[0].displayName, "José");
});

test("a legacy charset decodes instead of mojibake", () => {
	const vcf = card("VERSION:2.1", "FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Andr=E9", "EMAIL:andre@example.com");
	assert.equal(parseVcfContacts(vcf).contacts[0].displayName, "André");
});

test("the PREF email wins when a card carries several", () => {
	const { contacts } = parseVcfContacts(card(
		"FN:Two Mails",
		"item1.EMAIL;type=INTERNET:second@example.com",
		"item2.EMAIL;type=INTERNET;type=pref:first@example.com",
	));
	assert.equal(contacts[0].email, "first@example.com");
});

test("text escapes in names are unescaped, and mailto: prefixes come off addresses", () => {
	const { contacts } = parseVcfContacts(card("FN:Doe\\, John", "EMAIL:mailto:jdoe@example.com"));
	assert.deepEqual(contacts[0], { email: "jdoe@example.com", displayName: "Doe, John" });
});

test("cards without a usable email, junk between cards and unterminated cards are skipped", () => {
	const vcf = [
		"random header junk\r\n",
		card("FN:No Mail"),
		card("FN:Bad Mail", "EMAIL:not-an-email"),
		card("FN:Ok", "EMAIL:ok@example.com"),
		// Truncated mid-card: counted as skipped, never imported.
		"BEGIN:VCARD\r\nFN:Never Ends\r\nEMAIL:never@example.com",
	].join("");
	const { contacts, skipped } = parseVcfContacts(vcf);
	assert.deepEqual(contacts.map((c) => c.email), ["ok@example.com"]);
	assert.equal(skipped, 3);
});

test("the file's first card wins when an address repeats", () => {
	const vcf = card("FN:First", "EMAIL:dup@example.com") + card("FN:Second", "EMAIL:DUP@example.com");
	const { contacts, skipped } = parseVcfContacts(vcf);
	assert.deepEqual(contacts, [{ email: "dup@example.com", displayName: "First" }]);
	assert.equal(skipped, 1);
});

test("names longer than the API's 100-char bound are truncated", () => {
	const { contacts } = parseVcfContacts(card(`FN:${"x".repeat(150)}`, "EMAIL:a@example.com"));
	assert.equal(contacts[0].displayName.length, 100);
});

test("the card cap stops reading and counts the rest as skipped", () => {
	const vcf = card("EMAIL:a@example.com") + card("EMAIL:b@example.com") + card("EMAIL:c@example.com");
	const { contacts, skipped } = parseVcfContacts(vcf, 2);
	assert.equal(contacts.length, 2);
	assert.equal(skipped, 1);
});

test("LF endings, lowercase markers and a UTF-16 file all parse", () => {
	const { contacts } = parseVcfContacts("begin:vcard\nFN:Line Feed\nemail:lf@example.com\nend:vcard\n");
	assert.equal(contacts[0].email, "lf@example.com");

	const utf16 = Buffer.from(`BEGIN:VCARD\nFN:Séverine\nEMAIL:sev@example.com\nEND:VCARD\n`, "utf16le");
	const { contacts: wide } = parseVcfContacts(decodeVcfBytes(new Uint8Array([0xff, 0xfe, ...utf16]).buffer));
	assert.deepEqual(wide, [{ email: "sev@example.com", displayName: "Séverine" }]);
});

// ------------------------------------------------------------------ route ---

test("the owner imports new contacts, renames existing ones and gets per-card counts", async (t) => {
	const sqlite = await setup(t, "admin");
	const vcf = [
		card("FN:Maya Smith", "EMAIL:maya@example.com"),
		card("FN:Renamed", "EMAIL:existing@example.com"),
		card("FN:Dup", "EMAIL:maya@example.com"),
		card("FN:No Mail"),
		card("FN:Bad", "EMAIL:junk"),
	].join("");
	const response = await POST(post("mb-admin", vcf));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { imported: 1, updated: 1, skipped: 3, failed: 0 });
	assert.deepEqual(contactsOf(sqlite, "admin"), [
		{ email: "existing@example.com", display_name: "Renamed", source: "manual" },
		{ email: "maya@example.com", display_name: "Maya Smith", source: "manual" },
	]);
});

test("a card without FN updates the row but keeps the stored name", async (t) => {
	const sqlite = await setup(t, "admin");
	const response = await POST(post("mb-admin", card("EMAIL:existing@example.com")));
	assert.deepEqual(await response.json(), { imported: 0, updated: 1, skipped: 0, failed: 0 });
	assert.deepEqual(contactsOf(sqlite, "admin"), [{ email: "existing@example.com", display_name: "Old Name", source: "manual" }]);
});

test("a full-access delegate imports into the shared mailbox owner's address book", async (t) => {
	const sqlite = await setup(t, "delegate");
	const response = await POST(post("mb-team", card("FN:Mate", "EMAIL:mate@example.com")));
	assert.deepEqual(await response.json(), { imported: 1, updated: 0, skipped: 0, failed: 0 });
	const mate = contactsOf(sqlite, "admin").find((row) => row.email === "mate@example.com");
	assert.equal(mate.display_name, "Mate");
	assert.equal(contactsOf(sqlite, "delegate").length, 0);
});

test("a card that throws mid-write counts as failed without aborting the batch", async (t) => {
	await setup(t, "admin");
	const vcf = card("FN:Boom", "EMAIL:boom@example.com") + card("FN:Fine", "EMAIL:fine@example.com");
	const response = await POST(post("mb-admin", vcf));
	assert.deepEqual(await response.json(), { imported: 1, updated: 0, skipped: 0, failed: 1 });
});

test("files over the card cap still import the first batch and count the rest as skipped", async (t) => {
	await setup(t, "admin");
	const vcf = Array.from({ length: VCARD_IMPORT_MAX_CARDS + 1 }, (_, i) => card(`EMAIL:u${i}@example.com`)).join("");
	const response = await POST(post("mb-admin", vcf));
	assert.deepEqual(await response.json(), { imported: VCARD_IMPORT_MAX_CARDS, updated: 0, skipped: 1, failed: 0 });
});

test("missing mailbox, missing or empty file and an unparsable upload are 400s", async (t) => {
	await setup(t, "admin");
	assert.equal((await POST(post(null, card("EMAIL:a@example.com")))).status, 400);
	assert.equal((await POST(post("mb-admin", null))).status, 400);
	assert.equal((await POST(post("mb-admin", ""))).status, 400);
});

test("mailboxes the user cannot manage return 404", async (t) => {
	await setup(t, "author"); // send_on_behalf on mb-team: below full_access, so not canManage
	const vcf = card("EMAIL:a@example.com");
	assert.equal((await POST(post("mb-team", vcf))).status, 404);
	assert.equal((await POST(post("mb-nope", vcf))).status, 404);
});

test("an oversized upload returns 413", async (t) => {
	await setup(t, "admin");
	const response = await POST(post("mb-admin", `${card("EMAIL:a@example.com")}${"x".repeat(5 * 1024 * 1024)}`));
	assert.equal(response.status, 413);
});
