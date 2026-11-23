import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// F09: the mailing-list management API. A list belongs to its owning user —
// everyone else gets the same 404 as a missing row. Creating an address
// collision-checks the way routing resolves: mailboxes and aliases by
// tag-stripped local part, other lists with the tag kept. Cloudflare worker
// routes follow the alias-create precedent, and deletion keeps the rule while
// another claimant still resolves the address.

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.listEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){ if (!globalThis.listUser) throw new Error('Unauthorized'); return globalThis.listUser }",
	"@/lib/cloudflare-api": `
		export async function ensureEmailRoutingRuleToWorker(env, zoneId, address){
			globalThis.cfCalls.push(["ensure", zoneId, address]);
			if (globalThis.cfFail) throw new Error("cloudflare down");
		}
		export async function deleteEmailRoutingRuleForAddress(env, zoneId, address){
			globalThis.cfCalls.push(["delete", zoneId, address]);
			if (globalThis.cfFailDelete) throw new Error("cloudflare down");
		}
	`,
};
const { app, newDatabase } = await loadApp("list-api", `
	export * as lists from "./src/app/api/mailing-lists/route.ts";
	export * as list from "./src/app/api/mailing-lists/[id]/route.ts";
	export * as members from "./src/app/api/mailing-lists/[id]/members/route.ts";
`, { mocks });

const admin = { id: "admin", role: "admin", canManageMailboxes: true, createdByUserId: null };
const other = { id: "other", role: "user", canManageMailboxes: false, createdByUserId: null };
const delegate = { id: "delegate", role: "user", canManageMailboxes: true, createdByUserId: "admin" };

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, can_manage_mailboxes, created_by_user_id, created_at) VALUES
		('admin', 'admin@one.test', 'hash', 'Admin', 'admin', 1, NULL, 1),
		('other', 'other@other.test', 'hash', 'Other', 'user', 0, NULL, 1),
		('delegate', 'delegate@one.test', 'hash', 'Delegate', 'user', 1, 'admin', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at) VALUES
		('d-one', 'admin', 'one.test', 'z1', 'active', 'cloudflare', 1),
		('d-two', 'admin', 'two.test', 'z2', 'active', 'resend', 1),
		('d-pending', 'admin', 'pending.test', 'z3', 'pending', 'cloudflare', 1),
		('d-other', 'other', 'other.test', 'z9', 'active', 'cloudflare', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, use_all_domains, created_at) VALUES
		('mb-team', 'admin', 'd-one', 'team', 1, 1),
		('mb-other', 'other', 'd-other', 'other', 1, 1);
	INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, enabled, created_at) VALUES
		('al-nick', 'mb-team', 'd-one', 'nick', 1, 1);
`;

async function setup(t, user = admin) {
	const { env, sqlite, db } = await newDatabase(t, seed);
	globalThis.listEnv = env;
	globalThis.listUser = user;
	globalThis.cfCalls = [];
	globalThis.cfFail = false;
	globalThis.cfFailDelete = false;
	return { env, sqlite, db };
}

const req = (path, method = "GET", body) => new Request(`https://mail.test${path}`, {
	method,
	headers: { "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const create = (body) => app.lists.POST(req("/api/mailing-lists", "POST", body));

test("a list is created with a lowercased local part, defaults, and a Cloudflare rule", async (t) => {
	const { sqlite } = await setup(t);
	const created = await create({ domainId: "d-one", localPart: "Cr.Ew", name: "The Crew" });
	assert.equal(created.status, 200);
	const body = await created.json();
	// Stored raw-lowercased like a mailbox local part — dots kept, resolver
	// normalization happens at lookup time, not on write.
	assert.equal(body.list.address, "cr.ew@one.test");
	assert.equal(body.list.localPart, "cr.ew");
	assert.equal(body.list.postingPolicy, "members_only");
	assert.equal(body.list.moderated, false);
	assert.equal(body.list.memberCount, 0);
	assert.deepEqual(sqlite.prepare("SELECT local_part, name FROM mailing_lists WHERE id = ?").get(body.list.id),
		{ local_part: "cr.ew", name: "The Crew" });
	assert.deepEqual(globalThis.cfCalls, [["ensure", "z1", "cr.ew@one.test"]]);
});

test("create collides with mailboxes and aliases by tag-stripped local part", async (t) => {
	await setup(t);
	for (const localPart of ["team", "T.Eam", "team+x"]) {
		const res = await create({ domainId: "d-one", localPart, name: "L" });
		assert.equal(res.status, 409, localPart);
		assert.match((await res.json()).error, /mailbox/i);
	}
	const aliased = await create({ domainId: "d-one", localPart: "N.ICK", name: "L" });
	assert.equal(aliased.status, 409);
	assert.match((await aliased.json()).error, /alias/i);
});

test("create collides with another list by tag-kept local part, but +tag variants coexist", async (t) => {
	await setup(t);
	assert.equal((await create({ domainId: "d-one", localPart: "crew", name: "L" })).status, 200);
	for (const localPart of ["crew", "C.R.EW"]) {
		const res = await create({ domainId: "d-one", localPart, name: "L" });
		assert.equal(res.status, 409, localPart);
		assert.match((await res.json()).error, /mailing list/i);
	}
	// A literal +tag list is a different claim from the base list by design.
	assert.equal((await create({ domainId: "d-one", localPart: "crew+x", name: "L" })).status, 200);
	// The same address on another domain is a different address entirely.
	assert.equal((await create({ domainId: "d-two", localPart: "crew", name: "L" })).status, 200);
});

test("a use-all-domains mailbox shadows the address on its other domains", async (t) => {
	await setup(t);
	// mb-team has use_all_domains, so team@two.test already resolves to it.
	const res = await create({ domainId: "d-two", localPart: "team", name: "L" });
	assert.equal(res.status, 409);
	assert.match((await res.json()).error, /mailbox/i);
});

test("create requires an active domain the caller can use", async (t) => {
	await setup(t);
	assert.equal((await create({ domainId: "d-pending", localPart: "crew", name: "L" })).status, 404);
	assert.equal((await create({ domainId: "d-missing", localPart: "crew", name: "L" })).status, 404);
	// admin did not create "other", so their domain is off-limits.
	assert.equal((await create({ domainId: "d-other", localPart: "crew", name: "L" })).status, 404);

	await setup(t, other);
	const own = await create({ domainId: "d-other", localPart: "crew", name: "L" });
	assert.equal(own.status, 200);
	assert.deepEqual(globalThis.cfCalls, [["ensure", "z9", "crew@other.test"]]);

	// A managed user may create on their creator's domain; the list is theirs.
	await setup(t, delegate);
	const made = await create({ domainId: "d-one", localPart: "crew", name: "L" });
	assert.equal(made.status, 200);
	assert.equal((await made.json()).list.userId, "delegate");
});

test("listing returns only the caller's lists with member counts", async (t) => {
	const { sqlite } = await setup(t);
	await create({ domainId: "d-one", localPart: "crew", name: "Crew" });
	await create({ domainId: "d-one", localPart: "eng", name: "Eng" });
	sqlite.prepare("INSERT INTO mailing_lists (id, user_id, domain_id, local_part, name, created_at) VALUES ('foreign', 'other', 'd-other', 'theirs', 'Theirs', 1)").run();
	sqlite.prepare("INSERT INTO mailing_list_members (id, list_id, email, created_at) VALUES ('m1', (SELECT id FROM mailing_lists WHERE local_part = 'crew'), 'a@x.test', 1)").run();

	const body = await (await app.lists.GET(req("/api/mailing-lists"))).json();
	assert.deepEqual(body.lists.map((row) => row.localPart).sort(), ["crew", "eng"]);
	assert.equal(body.lists.find((row) => row.localPart === "crew").memberCount, 1);
	assert.equal(body.lists.find((row) => row.localPart === "eng").memberCount, 0);
});

test("validation rejects malformed local parts, names and payloads", async (t) => {
	await setup(t);
	for (const localPart of ["bad part", "!!", "...", "+x", "a".repeat(65)]) {
		assert.equal((await create({ domainId: "d-one", localPart, name: "L" })).status, 400, localPart);
	}
	assert.equal((await create({ domainId: "d-one", localPart: "crew" })).status, 400); // name required
	assert.equal((await create({ domainId: "d-one", localPart: "crew", name: "a\nb" })).status, 400);
	assert.equal((await create({ domainId: "d-one", localPart: "crew", name: "L", postingPolicy: "bogus" })).status, 400);
	assert.equal((await app.lists.POST(req("/api/mailing-lists", "POST", [1, 2]))).status, 400);
});

test("read, patch and delete are owner-only and members cascade", async (t) => {
	const { sqlite } = await setup(t);
	const listId = (await (await create({ domainId: "d-one", localPart: "crew", name: "Crew" })).json()).list.id;
	await app.members.POST(req(`/api/mailing-lists/${listId}/members`, "POST", { email: "a@x.test", role: "owner" }), ctx(listId));

	// The owner reads the list with its members.
	const detail = await (await app.list.GET(req(`/api/mailing-lists/${listId}`), ctx(listId))).json();
	assert.equal(detail.list.id, listId);
	assert.equal(detail.list.memberCount, 1);
	assert.equal(detail.members.length, 1);
	assert.equal(detail.members[0].email, "a@x.test");

	// Another user gets the 404 every item route produces, and nothing changes.
	globalThis.listUser = other;
	for (const res of [
		await app.list.GET(req(`/api/mailing-lists/${listId}`), ctx(listId)),
		await app.list.PATCH(req(`/api/mailing-lists/${listId}`, "PATCH", { name: "H" }), ctx(listId)),
		await app.list.DELETE(req(`/api/mailing-lists/${listId}`, "DELETE"), ctx(listId)),
		await app.members.GET(req(`/api/mailing-lists/${listId}/members`), ctx(listId)),
		await app.members.POST(req(`/api/mailing-lists/${listId}/members`, "POST", { email: "b@x.test" }), ctx(listId)),
		await app.members.PATCH(req(`/api/mailing-lists/${listId}/members`, "PATCH", { memberId: "x", role: "owner" }), ctx(listId)),
		await app.members.DELETE(req(`/api/mailing-lists/${listId}/members?memberId=x`, "DELETE"), ctx(listId)),
	]) assert.equal(res.status, 404);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mailing_list_members WHERE list_id = ?").get(listId).n, 1);

	// The owner patches fields; an empty patch is a 400 like the alias routes.
	globalThis.listUser = admin;
	assert.equal((await app.list.PATCH(req(`/api/mailing-lists/${listId}`, "PATCH", {}), ctx(listId))).status, 400);
	const patched = await app.list.PATCH(req(`/api/mailing-lists/${listId}`, "PATCH", {
		name: "New", description: "d", postingPolicy: "anyone", moderated: true,
	}), ctx(listId));
	assert.equal(patched.status, 200);
	const updated = (await patched.json()).list;
	assert.equal(updated.name, "New");
	assert.equal(updated.description, "d");
	assert.equal(updated.postingPolicy, "anyone");
	assert.equal(updated.moderated, true);

	// Deleting the list removes the address rule and cascades its members.
	globalThis.cfCalls = [];
	assert.equal((await app.list.DELETE(req(`/api/mailing-lists/${listId}`, "DELETE"), ctx(listId))).status, 200);
	assert.deepEqual(globalThis.cfCalls, [["delete", "z1", "crew@one.test"]]);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mailing_lists WHERE id = ?").get(listId).n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mailing_list_members WHERE list_id = ?").get(listId).n, 0);
});

test("disabling and re-enabling toggles claiming and restores the route", async (t) => {
	const { sqlite } = await setup(t);
	const listId = (await (await create({ domainId: "d-one", localPart: "crew", name: "Crew" })).json()).list.id;
	globalThis.cfCalls = [];

	await app.list.PATCH(req(`/api/mailing-lists/${listId}`, "PATCH", { disabled: true }), ctx(listId));
	assert.equal(sqlite.prepare("SELECT disabled FROM mailing_lists WHERE id = ?").get(listId).disabled, 1);
	assert.equal(globalThis.cfCalls.length, 0);

	const back = await app.list.PATCH(req(`/api/mailing-lists/${listId}`, "PATCH", { disabled: false }), ctx(listId));
	assert.equal(back.status, 200);
	assert.equal(sqlite.prepare("SELECT disabled FROM mailing_lists WHERE id = ?").get(listId).disabled, 0);
	assert.deepEqual(globalThis.cfCalls, [["ensure", "z1", "crew@one.test"]]);
});

test("delete keeps the Cloudflare rule while another claimant resolves the address", async (t) => {
	const { sqlite } = await setup(t);
	// The documented gap: mailbox create does not check lists, so a mailbox can
	// be created over one. The rule must stay for the mailbox's mail.
	const listId = (await (await create({ domainId: "d-one", localPart: "crew", name: "Crew" })).json()).list.id;
	sqlite.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb-crew', 'admin', 'd-one', 'crew', 1)").run();
	globalThis.cfCalls = [];
	assert.equal((await app.list.DELETE(req(`/api/mailing-lists/${listId}`, "DELETE"), ctx(listId))).status, 200);
	assert.deepEqual(globalThis.cfCalls, [], "the rule must stay for the mailbox's address");

	// A base list inherits tagged fallback mail, so its rule stays too.
	const base = (await (await create({ domainId: "d-one", localPart: "edge", name: "E" })).json()).list.id;
	const tagged = (await (await create({ domainId: "d-one", localPart: "edge+x", name: "E" })).json()).list.id;
	globalThis.cfCalls = [];
	await app.list.DELETE(req(`/api/mailing-lists/${tagged}`, "DELETE"), ctx(tagged));
	assert.deepEqual(globalThis.cfCalls, [], "edge+x mail now falls back to the edge list");
	await app.list.DELETE(req(`/api/mailing-lists/${base}`, "DELETE"), ctx(base));
	assert.deepEqual(globalThis.cfCalls, [["delete", "z1", "edge@one.test"]]);
});

test("a literal-only +tag address loses its rule even with a base list present", async (t) => {
	await setup(t);
	await create({ domainId: "d-one", localPart: "edge", name: "E" });
	const literal = (await (await create({ domainId: "d-one", localPart: "edge+", name: "E" })).json()).list.id;
	globalThis.cfCalls = [];
	await app.list.DELETE(req(`/api/mailing-lists/${literal}`, "DELETE"), ctx(literal));
	// edge+ is literal-only for lists: the edge base never claims it.
	assert.deepEqual(globalThis.cfCalls, [["delete", "z1", "edge+@one.test"]]);
});

test("non-cloudflare domains skip routing calls; Cloudflare failure rolls back", async (t) => {
	const { sqlite } = await setup(t);
	const resend = await create({ domainId: "d-two", localPart: "crew", name: "L" });
	assert.equal(resend.status, 200);
	assert.deepEqual(globalThis.cfCalls, []);

	globalThis.cfFail = true;
	const failed = await create({ domainId: "d-one", localPart: "crew", name: "L" });
	assert.equal(failed.status, 502);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mailing_lists WHERE local_part = 'crew' AND domain_id = 'd-one'").get().n, 0);
});

test("members can be added, patched and removed with duplicate and enum checks", async (t) => {
	const { sqlite } = await setup(t);
	const listId = (await (await create({ domainId: "d-one", localPart: "crew", name: "Crew" })).json()).list.id;
	const call = (m, body, suffix = "") => app.members[m](req(`/api/mailing-lists/${listId}/members${suffix}`, m === "GET" ? "GET" : m, body), ctx(listId));

	// Emails normalize on the way in; the same address twice is a conflict.
	let res = await call("POST", { email: " Bob@X.Test ", name: "Bob", role: "owner", moderated: true });
	let { members } = await res.json();
	assert.equal(members.length, 1);
	assert.equal(members[0].email, "bob@x.test");
	assert.equal(members[0].role, "owner");
	assert.equal(members[0].moderated, true);
	res = await call("POST", { email: "BOB@x.test" });
	assert.equal(res.status, 409);

	// Bad input is a 400: malformed email, unknown role, header-unsafe name.
	for (const body of [{ email: "not-an-email" }, { email: "c@x.test", role: "admin" }, { email: "c@x.test", name: "a\rb" }]) {
		assert.equal((await call("POST", body)).status, 400, JSON.stringify(body));
	}
	assert.equal((await call("POST", { email: "c@x.test", role: "member" })).status, 200);

	// Patch flips role and flags by member id; clearing a name works too.
	const memberId = members[0].id;
	res = await call("PATCH", { memberId, role: "member", moderated: false, name: null });
	({ members } = await res.json());
	assert.equal(members.find((m) => m.id === memberId).role, "member");
	assert.equal(members.find((m) => m.id === memberId).name, null);
	assert.equal((await call("PATCH", { memberId })).status, 400); // nothing to update
	assert.equal((await call("PATCH", { memberId: "nope", role: "owner" })).status, 404);

	// Remove by member id; a member of another list is a 404, not a cross-delete.
	res = await call("DELETE", undefined, `?memberId=${memberId}`);
	({ members } = await res.json());
	assert.deepEqual(members.map((m) => m.email), ["c@x.test"]);
	assert.equal((await call("DELETE", undefined, "")).status, 400); // memberId required
	assert.equal((await call("DELETE", undefined, "?memberId=zzz")).status, 404);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mailing_list_members WHERE list_id = ?").get(listId).n, 1);
});
