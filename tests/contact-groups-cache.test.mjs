import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

// Same cache discipline as the F10 mailing-list gate: the app's QueryClient
// disables refetchOnMount/reconnect/focus, so mutations must write the groups
// snapshot themselves; all group and member writes share one scope; and a
// member PATCH response carries no memberCount, so the cache keeps its own.
// The contact book is owner-scoped — several mailbox keys can front the same
// groups — so refetches invalidate the whole "contact-groups" prefix.

const g1 = { id: "g-1", userId: "u-1", name: "Family", createdAt: "2026-01-01T00:00:00.000Z" };
const g2 = { id: "g-2", userId: "u-1", name: "Work", createdAt: "2026-01-01T00:00:00.000Z" };
const m1 = {
	id: "cgm-1", contactId: "c-1", email: "ada@example.com", displayName: "Ada",
	hasAvatar: false, createdAt: "2026-01-01T00:00:00.000Z",
};
const contact = {
	id: "c-1", userId: "u-1", email: "ada@example.com", displayName: "Ada",
	source: "manual", blocked: false, remoteContentAllowed: false,
	lastSeenAt: null, createdAt: "2026-01-01T00:00:00.000Z", hasAvatar: false,
};

const state = {
	groups: [g1, g2],
	members: { "g-1": [m1], "g-2": [] },
	contacts: [],
	nextGroupId: 3,
	deferIndex: null,
	deferMembers: null,
	deferCreates: null,
	failIndex: false,
	failMembers: new Set(),
};

const groupEntry = (group) => ({ ...group, memberCount: (state.members[group.id] ?? []).length });
// The real index orders by lower(name) then id — the mock must sort the same way.
const sortedGroups = () =>
	[...state.groups].sort((a, b) => {
		const an = a.name.toLowerCase();
		const bn = b.name.toLowerCase();
		return an < bn ? -1 : an > bn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

function response(data, status = 200) {
	return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

const requests = [];
globalThis.__groupsCacheTestFetch = async (url, options = {}) => {
	const method = options.method || "GET";
	const payload = options.body ? JSON.parse(options.body) : null;
	requests.push({ url, method, payload });
	const parsed = new URL(url, "https://mail.example");
	const path = parsed.pathname;
	if (path === "/api/contacts" && method === "GET") {
		return response({ contacts: state.contacts });
	}
	if (path === "/api/contacts" && method === "DELETE") {
		// Contact deletes cascade group memberships server-side.
		state.members = Object.fromEntries(
			Object.entries(state.members).map(([id, list]) => [id, list.filter((entry) => entry.contactId !== "c-1")]),
		);
		return response({ ok: true });
	}
	if (path === "/api/contacts/groups" && method === "GET") {
		if (state.failIndex) return response({ error: "Boom" }, 500);
		// Capture before deferring — a delayed response still returns the pre-request snapshot.
		const data = { groups: sortedGroups().map(groupEntry) };
		if (state.deferIndex) await state.deferIndex;
		return response(data);
	}
	if (path === "/api/contacts/groups" && method === "POST") {
		if (state.deferCreates) await state.deferCreates;
		const group = {
			id: `g-${state.nextGroupId++}`, userId: "u-1", name: payload.name,
			createdAt: "2026-01-02T00:00:00.000Z",
		};
		state.groups.push(group);
		state.members[group.id] = [];
		return response({ group: { ...group, memberCount: 0 } });
	}
	const memberMatch = path.match(/^\/api\/contacts\/groups\/([^/]+)\/members$/);
	if (memberMatch) {
		const groupId = memberMatch[1];
		if (method === "GET" && state.failMembers.has(groupId)) return response({ error: "Boom" }, 500);
		if (state.deferMembers && method !== "GET") await state.deferMembers;
		const list = state.members[groupId] ?? [];
		if (method === "GET") return response({ members: list });
		if (method === "POST") {
			const member = {
				id: `cgm-${list.length + 1}`, contactId: payload.contactId,
				email: "ada@example.com", displayName: "Ada", hasAvatar: false,
				createdAt: "2026-01-03T00:00:00.000Z",
			};
			state.members[groupId] = [...list, member];
			return response({ members: state.members[groupId] });
		}
		if (method === "DELETE") {
			const contactId = parsed.searchParams.get("contactId");
			state.members[groupId] = list.filter((entry) => entry.contactId !== contactId);
			return response({ members: state.members[groupId] });
		}
	}
	const groupMatch = path.match(/^\/api\/contacts\/groups\/([^/]+)$/);
	if (groupMatch) {
		const group = state.groups.find((entry) => entry.id === groupMatch[1]);
		if (!group) return response({ error: "Group not found" }, 404);
		if (method === "PATCH") {
			group.name = payload.name;
			// The real PATCH answers the raw row — no memberCount.
			return response({ group });
		}
		if (method === "DELETE") {
			state.groups = state.groups.filter((entry) => entry.id !== group.id);
			delete state.members[group.id];
			return response({ ok: true });
		}
	}
	return response({ error: "Unexpected route " + method + " " + url }, 500);
};

beforeEach(() => {
	state.groups = [{ ...g1 }, { ...g2 }];
	state.members = { "g-1": [{ ...m1 }], "g-2": [] };
	state.nextGroupId = 3;
	state.contacts = [];
	state.deferIndex = state.deferMembers = state.deferCreates = null;
	state.failIndex = false;
	state.failMembers = new Set();
	globalThis.__testMailbox = { id: "mb-1", permission: "full_access" };
	requests.length = 0;
});

const tStub = `export function useLanguage() {
	return { t(key, vars) {
		if (vars && vars.count !== undefined) return key + " " + vars.count;
		if (vars && vars.name !== undefined) return key + " " + vars.name;
		return key;
	} };
}`;

const mailboxStub = `export function useSelectedMailbox() {
	return { selectedMailbox: globalThis.__testMailbox ?? null };
}`;

const uiStubs = {
	"@/components/language-provider": tStub,
	"@/components/mailbox-provider": mailboxStub,
	"@/lib/auth/client": `export function authFetch(...args){return globalThis.__groupsCacheTestFetch(...args);}`,
	"@/components/icons": `import React from "react"; const i = () => null;
		export const Check = i, Pencil = i, Tags = i, Trash2 = i, X = i, Tag01 = i,
		Plus = i, Search = i, UsersRound = i;`,
	"@/components/ui/badge": `import React from "react"; export function Badge({children,...p}){return React.createElement("span",p,children);}`,
	"@/components/ui/button": `import React from "react"; export const Button = React.forwardRef(function Button({children,size,variant,pill,asChild,...props},ref){return React.createElement("button",{...props,ref},children);});`,
	"@/components/ui/checkbox": `import React from "react"; export const Checkbox = React.forwardRef(function Checkbox(props,ref){return React.createElement("input",{type:"checkbox",...props,ref});});`,
	"@/components/ui/confirm-dialog": `export function confirmDestructive(){return Promise.resolve(true);} export function confirmDialog(){return Promise.resolve(true);} export function alertDialog(){return Promise.resolve();}`,
	"@/components/ui/dialog": `import React from "react";
const DialogCtx = React.createContext({open:false,onOpenChange:()=>{}});
export function Dialog({open,onOpenChange,children}){
	return React.createElement(DialogCtx.Provider,{value:{open,onOpenChange}},children);
}
export function DialogTrigger({children}){
	const {onOpenChange} = React.useContext(DialogCtx);
	const child = React.Children.only(children);
	return React.cloneElement(child,{onClick:e=>{if(child.props.onClick)child.props.onClick(e);onOpenChange(true);}});
}
export function DialogContent({children,onCloseAutoFocus,...props}){
	const {open} = React.useContext(DialogCtx);
	return open ? React.createElement("div",props,children) : null;
}
export function DialogHeader({children}){return React.createElement("div",null,children);}
export function DialogTitle({children}){return React.createElement("h2",null,children);}
export function DialogDescription({children}){return React.createElement("p",null,children);}`,
	"@/components/ui/input": `import React from "react"; export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});`,
	"@/components/ui/skeleton": `import React from "react"; export function Skeleton(props){return React.createElement("div",props);}`,
	"@/components/ui/tooltip": `import React from "react"; export function Tooltip({children}){return React.createElement(React.Fragment,null,children);}`,
};

const { ContactGroupsManager } = await loadComponent("src/components/contacts/contact-groups-manager.tsx", uiStubs);
const { ContactGroupsDialog } = await loadComponent("src/components/contacts/contact-groups-dialog.tsx", uiStubs);
const { ContactGroupsAction } = await loadComponent("src/components/contacts/contact-groups-action.tsx", uiStubs);
const { ContactDeleteDialog } = await loadComponent("src/components/contacts/contact-delete-dialog.tsx", uiStubs);
const {
	contactGroupMembersQueryKey,
	contactGroupsQueryKey,
	fetchContactGroupMembers,
	fetchContactGroups,
	patchContactGroupMembers,
	refetchContactGroups,
} = await loadComponent("src/components/contacts/contact-groups-utils.ts", uiStubs);

// The page mounts the REAL groups manager — only its row and sibling dialogs
// (irrelevant to a zero-contacts render) are stubbed out.
const pageStubs = {
	...uiStubs,
	"@/components/compose/compose-context": `export function useCompose(){return {openComposer(){}};}`,
	"@/lib/email/address": `export function formatEmailAddress(email){return email;}`,
	"@/components/page-skeletons": `import React from "react"; export function SectionRowSkeleton(){return React.createElement("div",null);}`,
	"@/components/page-header-utils": `export const mobilePrimaryActionClass = "";`,
	"@/components/ui/list": `import React from "react"; export function List({children}){return React.createElement("div",null,children);} export function ListRow({children,...p}){return React.createElement("div",p,children);}`,
	"./contact-row": `export function ContactRow(){return null;}`,
	"./contact-edit-dialog": `export function ContactEditDialog(){return null;}`,
	"./contact-delete-dialog": `export function ContactDeleteDialog(){return null;}`,
};
const { ContactsPage } = await loadComponent("src/components/contacts/contacts-page.tsx", pageStubs);

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

// Mirrors src/components/providers.tsx: refetchOnMount/-reconnect/-focus off.
function testClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnMount: false,
				refetchOnReconnect: false,
				refetchOnWindowFocus: false,
				retry: false, // surface error states immediately — the app's client retries on its own cadence
				staleTime: 60_000,
				gcTime: Infinity, // no GC timers — default 5-minute GC would keep Node alive
			},
			mutations: { gcTime: Infinity },
		},
	});
}

function newContainer(t) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	t.after(() => container.remove());
	return container;
}

function mount(t, client, container, element) {
	const reactRoot = createRoot(container);
	// A stranded mounted root keeps jsdom's scheduler ports open and the test
	// process never exits — always unmount even when an assertion throws.
	t.after(async () => {
		if (!reactRoot.__unmounted) await act(async () => reactRoot.unmount());
	});
	act(() => {
		reactRoot.render(createElement(QueryClientProvider, { client }, element));
	});
	return reactRoot;
}

const assignProps = { mailboxId: "mb-1", contact, open: true, onOpenChange: () => {} };
const assignDialog = () => createElement(ContactGroupsDialog, assignProps);

async function unmount(reactRoot, container) {
	if (reactRoot.__unmounted) return;
	reactRoot.__unmounted = true;
	await act(async () => reactRoot.unmount());
	container.remove();
}

async function settle(ms = 30) {
	await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function click(element) {
	await act(async () => {
		element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 10));
	});
}

async function setInputValue(input, value) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

const memberRequests = () => requests.filter((r) => r.method === "GET" && r.url.includes("/members"));

test("a full-access page with zero visible contacts still exposes the groups entry", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, createElement(ContactsPage));
	await settle();

	// The contact list is empty — no row can carry the affordance.
	assert.match(container.textContent, /contacts\.empty/);
	const manage = [...container.querySelectorAll("button")].find((b) =>
		b.textContent.includes("contactGroups.manage"));
	assert.ok(manage, "the standalone manage entry renders without any contacts");
	await click(manage);
	await settle();

	assert.ok(
		requests.some((r) => r.url === "/api/contacts/groups?mailboxId=mb-1"),
		"opening the manager fetches the group index",
	);
	assert.match(container.textContent, /Family/);
	assert.match(container.textContent, /contactGroups.memberCount 1/);
	await unmount(root, container);
});

test("a read-only page hides the standalone groups entry", async (t) => {
	globalThis.__testMailbox = { id: "mb-1", permission: "read_only" };
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, createElement(ContactsPage));
	await settle();

	assert.equal(
		[...container.querySelectorAll("button")].filter((b) =>
			b.textContent.includes("contactGroups.manage")).length,
		0,
		"no manage entry without manage rights",
	);
	assert.equal(
		requests.filter((r) => r.url.includes("/api/contacts/groups")).length,
		0,
		"no groups request fires",
	);
	await unmount(root, container);
});

test("a read-only mount fires no groups requests and renders no affordances", async (t) => {
	globalThis.__testMailbox = { id: "mb-1", permission: "read_only" };
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container,
		createElement("div", null,
			createElement(ContactGroupsAction, { mailboxId: "mb-1", contact }),
			createElement(ContactGroupsManager, { mailboxId: "mb-1" }),
		),
	);
	await settle();

	assert.equal(requests.length, 0, "a doomed groups GET must not be fired");
	assert.equal(container.querySelectorAll("button").length, 0, "no groups buttons render");
	await unmount(root, container);
});

test("a permission downgrade hides the assign affordance and its open dialog", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container,
		createElement(ContactGroupsAction, { mailboxId: "mb-1", contact }));
	await settle();

	const tag = container.querySelector('button[aria-label^="contactGroups.editFor"]');
	assert.ok(tag, "the assign button renders for a manager");
	await click(tag);
	assert.match(container.textContent, /contactGroups.assignTitle/, "the dialog opened");

	globalThis.__testMailbox = { id: "mb-1", permission: "send_as" };
	// A fresh element — re-rendering the same element object hits React's
	// identical-element bailout and never re-reads the mailbox permission.
	await act(async () => {
		root.render(createElement(QueryClientProvider, { client },
			createElement(ContactGroupsAction, { mailboxId: "mb-1", contact })));
		await new Promise((r) => setTimeout(r, 10));
	});

	assert.equal(container.querySelector('button[aria-label^="contactGroups.editFor"]'), null, "button gone");
	assert.doesNotMatch(container.textContent, /contactGroups.assignTitle/, "dialog gone");
	await unmount(root, container);
});

test("the manager fetches only the group index — member slices stay lazy", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, createElement(ContactGroupsManager, { mailboxId: "mb-1" }));
	await settle();

	assert.equal(requests.length, 0, "mounting the trigger alone fetches nothing");
	const trigger = [...container.querySelectorAll("button")].find((b) =>
		b.textContent.includes("contactGroups.manage"));
	await click(trigger);
	await settle();

	assert.equal(requests.length, 1, "exactly one request fired");
	assert.equal(requests[0].url, "/api/contacts/groups?mailboxId=mb-1");
	assert.equal(memberRequests().length, 0, "no member requests for a count-only surface");
	assert.match(container.textContent, /contactGroups.memberCount 1/);
	await unmount(root, container);
});

test("the assign dialog loads member slices lazily and isolates a failure to one row", async (t) => {
	state.failMembers.add("g-2");
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, assignDialog());
	await settle();

	const indexRequests = requests.filter((r) => r.url === "/api/contacts/groups?mailboxId=mb-1");
	assert.equal(indexRequests.length, 1);
	assert.equal(memberRequests().length, 2, "one members GET per group while the surface is open");
	// The group index survived the failed slice: both rows still render.
	assert.match(container.textContent, /Family/);
	assert.match(container.textContent, /Work/);
	const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
	assert.equal(boxes.length, 2);
	assert.equal(boxes[0].checked, true, "Family membership resolved");
	assert.equal(boxes[0].disabled, false, "a healthy slice keeps its toggle usable");
	assert.equal(boxes[1].disabled, true, "the failed slice leaves its toggle unusable");
	assert.match(container.textContent, /undo\.retry/, "the failed row offers a retry");
	await unmount(root, container);
});

test("the assign dialog toggles membership and updates the cached count and slice", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, assignDialog());
	await settle();

	const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
	assert.equal(boxes[0].checked, true, "Family is checked — the contact is a member");
	assert.equal(boxes[1].checked, false, "Work is unchecked");

	await click(boxes[1]);
	await settle();
	const post = requests.find((r) => r.method === "POST" && r.url.includes("/members"));
	assert.deepEqual(post, {
		url: "/api/contacts/groups/g-2/members", method: "POST",
		payload: { mailboxId: "mb-1", contactId: "c-1" },
	});
	assert.equal(
		client.getQueryData(["contact-groups", "mb-1"]).find((g) => g.id === "g-2").memberCount,
		1,
	);
	assert.equal(client.getQueryData(["contact-groups", "mb-1", "members", "g-2"]).length, 1);

	await click(boxes[0]);
	await settle();
	const del = requests.find((r) => r.method === "DELETE" && r.url.includes("/members"));
	assert.equal(del.url, "/api/contacts/groups/g-1/members?mailboxId=mb-1&contactId=c-1");
	assert.equal(
		client.getQueryData(["contact-groups", "mb-1"]).find((g) => g.id === "g-1").memberCount,
		0,
	);
	assert.equal(client.getQueryData(["contact-groups", "mb-1", "members", "g-1"]).length, 0);
	await unmount(root, container);
});

test("two rapid toggles produce a single member write", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	let release;
	state.deferMembers = new Promise((r) => { release = r; });
	const container = newContainer(t);
	const root = mount(t, client, container, assignDialog());
	await settle();

	const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
	// Both changes land before the first write starts — only one may begin.
	await act(async () => {
		boxes[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		boxes[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 30));
	});

	const writes = requests.filter((r) => r.method !== "GET" && r.url.includes("/members"));
	assert.equal(writes.length, 1, "the write scope serializes member changes");
	const pending = [...container.querySelectorAll('input[type="checkbox"]')];
	assert.ok(pending.every((box) => box.disabled), "every toggle is gated while a write runs");

	await act(async () => { release(); state.deferMembers = null; await new Promise((r) => setTimeout(r, 30)); });
	const after = [...container.querySelectorAll('input[type="checkbox"]')];
	assert.ok(after.every((box) => !box.disabled), "toggles re-enable once the write settles");
	await unmount(root, container);
});

test("a member write landing on a dropped cache restarts the in-flight GET", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, assignDialog());
	await settle();

	// Start a member write and hold its POST.
	let releaseWrite;
	state.deferMembers = new Promise((r) => { releaseWrite = r; });
	const work = [...container.querySelectorAll('input[type="checkbox"]')][1];
	await act(async () => {
		work.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 10));
	});

	// The page navigates away mid-write and its cache is evicted.
	await unmount(root, container);
	client.removeQueries({ queryKey: ["contact-groups"] });

	// Revisiting starts a cold members GET while the write is still in flight.
	let releaseMembers;
	state.deferIndex = new Promise((r) => { releaseMembers = r; });
	const container2 = newContainer(t);
	const root2 = mount(t, client, container2, assignDialog());
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

	// The write lands: it cancels the cold GETs, finds no snapshots, and restarts them.
	await act(async () => { releaseWrite(); state.deferMembers = null; await new Promise((r) => setTimeout(r, 20)); });
	assert.equal(client.isMutating(), 0, "the write settles without waiting on the restarted GETs");
	await act(async () => { releaseMembers(); state.deferIndex = null; await new Promise((r) => setTimeout(r, 30)); });

	const slice = client.getQueryData(["contact-groups", "mb-1", "members", "g-2"]);
	assert.ok(slice, "the members query is not stranded pending");
	assert.equal(slice.length, 1, "the restarted GET returns post-write data");
	await unmount(root2, container2);
});

test("a create during the first load survives the cancelled index GET", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	let releaseIndex;
	state.deferIndex = new Promise((r) => { releaseIndex = r; });

	const container = newContainer(t);
	const root = mount(t, client, container, createElement(ContactGroupsManager, { mailboxId: "mb-1" }));
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const trigger = [...container.querySelectorAll("button")].find((b) =>
		b.textContent.includes("contactGroups.manage"));
	await click(trigger);

	const input = container.querySelector('input[aria-label="contactGroups.new"]');
	await setInputValue(input, "Beta");
	const createButton = [...container.querySelectorAll("button")].find((b) =>
		b.textContent === "contactGroups.create");
	await click(createButton);
	await settle();

	assert.equal(requests.filter((r) => r.method === "POST").length, 1, "the create POST was sent");
	// The stale first-load response lands now — after the mutation already committed.
	await act(async () => { releaseIndex(); state.deferIndex = null; await new Promise((r) => setTimeout(r, 30)); });

	const cached = client.getQueryData(["contact-groups", "mb-1"]);
	assert.ok(cached.some((entry) => entry.name === "Beta"), "the created group survives the late GET");
	await unmount(root, container);
});

test("deleting a group drops it and every mailbox's member slice for it", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, assignDialog());
	await settle();
	// A second mailbox fronts the same shared book and cached the same slice.
	client.setQueryData(["contact-groups", "mb-2", "members", "g-1"], [{ ...m1 }]);

	// The delete button lives in the manager, which nests inside the assign dialog footer.
	const manage = [...container.querySelectorAll("button")].find((b) =>
		b.textContent.includes("contactGroups.manage"));
	await click(manage);
	await settle();

	const removeButton = container.querySelector('button[aria-label="contactGroups.deleteFor Family"]');
	await click(removeButton);
	await settle();

	const del = requests.find((r) => r.method === "DELETE" && !r.url.includes("/members"));
	assert.deepEqual(del, { url: "/api/contacts/groups/g-1?mailboxId=mb-1", method: "DELETE", payload: null });
	assert.equal(client.getQueryData(["contact-groups", "mb-1"]).length, 1);
	assert.equal(client.getQueryData(["contact-groups", "mb-1", "members", "g-1"]), undefined);
	assert.equal(client.getQueryData(["contact-groups", "mb-2", "members", "g-1"]), undefined,
		"the same book's slice under another mailbox key is dropped too");
	await unmount(root, container);
});

test("refetchContactGroups refreshes live observers, stales the rest of the book", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	// The open dialog observes mb-1's index and member slices; a second mailbox
	// fronting the same owner book has fetchable but unwatched caches — prefetch
	// leaves a real queryFn on each, so an "all"-type refetch would fire reads.
	const root = mount(t, client, container, assignDialog());
	await settle();
	await client.prefetchQuery({
		queryKey: contactGroupsQueryKey("mb-2"),
		queryFn: () => fetchContactGroups("mb-2"),
	});
	await client.prefetchQuery({
		queryKey: contactGroupMembersQueryKey("mb-2", "g-1"),
		queryFn: () => fetchContactGroupMembers("mb-2", "g-1"),
	});
	const before = requests.length;

	refetchContactGroups(client);
	await settle();

	const refetched = requests.slice(before).filter((r) => r.method === "GET");
	assert.ok(
		refetched.some((r) => r.url === "/api/contacts/groups?mailboxId=mb-1"),
		"the observed mailbox's list refetches",
	);
	assert.ok(refetched.some((r) => r.url.includes("/members")), "observed member slices refetch");
	assert.equal(
		refetched.filter((r) => r.url.includes("mailboxId=mb-2")).length,
		0,
		"unwatched keys on the shared book do not refetch",
	);
	const otherBook = client
		.getQueryCache()
		.findAll({ queryKey: contactGroupsQueryKey("mb-2") });
	assert.equal(otherBook.length, 2);
	assert.ok(
		otherBook.every((query) => query.state.isInvalidated),
		"keys outside the observed mailbox are invalidated — they refetch on next enabled mount",
	);
	await unmount(root, container);
});

test("a write leaves downgraded-mailbox caches stale — no doomed reads", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	// mb-2 was browsed while it was manageable, then lost manage rights: its
	// cached queries still carry a working queryFn but no observer.
	await client.prefetchQuery({
		queryKey: contactGroupsQueryKey("mb-2"),
		queryFn: () => fetchContactGroups("mb-2"),
	});
	await client.prefetchQuery({
		queryKey: contactGroupMembersQueryKey("mb-2", "g-1"),
		queryFn: () => fetchContactGroupMembers("mb-2", "g-1"),
	});
	const root = mount(t, client, container, assignDialog());
	await settle();
	const before = requests.length;

	// A member write in mb-1 commits; the shared-book refresh then runs.
	const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
	await click(boxes[1]);
	await settle();

	const after = requests.slice(before);
	assert.ok(after.some((r) => r.method === "POST"), "the member write committed");
	assert.ok(
		after.some((r) => r.url === "/api/contacts/groups?mailboxId=mb-1"),
		"the writable mailbox's index refetches",
	);
	assert.equal(
		after.filter((r) => r.url.includes("mailboxId=mb-2")).length,
		0,
		"the downgraded mailbox fires no reads — its keys only go stale",
	);
	const stale = client.getQueryCache().find({ queryKey: contactGroupsQueryKey("mb-2") });
	assert.ok(stale?.state.isInvalidated, "mb-2's index is marked stale for its next enabled mount");
	await unmount(root, container);
});

test("a create landing after a downgrade fires no restart reads on the dead mailbox", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	// The initial index GET failed — no snapshot exists, so a committing write
	// falls into the no-data restart path.
	state.failIndex = true;
	let releaseCreate;
	state.deferCreates = new Promise((r) => { releaseCreate = r; });
	const root = mount(t, client, container,
		createElement(ContactGroupsManager, { mailboxId: "mb-1" }));
	await settle();
	const trigger = [...container.querySelectorAll("button")].find((b) =>
		b.textContent.includes("contactGroups.manage"));
	await click(trigger);
	await settle();

	const input = container.querySelector('input[aria-label="contactGroups.new"]');
	await setInputValue(input, "Beta");
	const createButton = [...container.querySelectorAll("button")].find((b) =>
		b.textContent === "contactGroups.create");
	await click(createButton);
	assert.equal(
		requests.filter((r) => r.method === "POST" && r.url === "/api/contacts/groups").length,
		1,
		"the create POST is in flight",
	);

	// The mailbox is read-only now and the surface is gone entirely — unmount
	// drops the last observer, so only the queryFn'd cache entry remains. The
	// mutation still commits (writes outlive their observers) and its restart
	// must not fire a read this mailbox can no longer serve.
	globalThis.__testMailbox = { id: "mb-1", permission: "read_only" };
	await unmount(root, container);
	const before = requests.length;
	await act(async () => {
		releaseCreate();
		state.deferCreates = null;
		await new Promise((r) => setTimeout(r, 40));
	});

	assert.equal(
		requests.slice(before).length,
		0,
		"no read fires through the restart or refresh paths once the mailbox is read-only",
	);
	const stale = client.getQueryCache().find({ queryKey: contactGroupsQueryKey("mb-1") });
	assert.ok(stale?.state.isInvalidated, "the no-data snapshot went stale-only instead of refetching");
	await unmount(root, container);
});

test("the member-slice restart also stays stale-only on an unwatched key", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	// A failed, unwatched slice keeps its queryFn — an "all" restart would refire it.
	state.failMembers.add("g-2");
	await client.prefetchQuery({
		queryKey: contactGroupMembersQueryKey("mb-1", "g-2"),
		queryFn: () => fetchContactGroupMembers("mb-1", "g-2"),
	});
	const before = requests.length;

	await patchContactGroupMembers(client, "mb-1", "g-2", [{ ...m1, id: "cgm-9" }]);
	await settle();

	assert.equal(requests.slice(before).length, 0, "no read fires on the unwatched slice");
	const stale = client.getQueryCache().find({ queryKey: contactGroupMembersQueryKey("mb-1", "g-2") });
	assert.ok(stale?.state.isInvalidated, "the slice went stale-only instead of refetching");
});

test("deleting a contact refreshes the groups book — counts and slices update", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	// The open assign dialog observes the index and both member slices — the
	// surface a delete would leave stale.
	const root = mount(t, client, container,
		createElement("div", null,
			assignDialog(),
			createElement(ContactDeleteDialog, {
				mailboxId: "mb-1", contact, onOpenChange: () => {}, onDeleted: () => {},
			}),
		),
	);
	await settle();
	assert.equal(client.getQueryData(["contact-groups", "mb-1", "members", "g-1"]).length, 1);
	const before = requests.length;

	const confirm = [...container.querySelectorAll("button")].find((b) => b.textContent === "common.delete");
	await click(confirm);
	await settle();

	const del = requests.find((r) => r.method === "DELETE" && r.url.startsWith("/api/contacts?"));
	assert.ok(del, "the contact DELETE was sent");
	const refetched = requests.slice(before).filter((r) => r.method === "GET");
	assert.ok(
		refetched.some((r) => r.url === "/api/contacts/groups?mailboxId=mb-1"),
		"the groups index refetches so the cascaded member count lands",
	);
	assert.ok(
		refetched.some((r) => r.url.includes("/members")),
		"the member slice refetches so the cascaded membership lands",
	);
	assert.equal(
		client.getQueryData(["contact-groups", "mb-1"]).find((entry) => entry.id === "g-1").memberCount,
		0,
		"the cascaded count lands in the index snapshot",
	);
	assert.equal(
		client.getQueryData(["contact-groups", "mb-1", "members", "g-1"]).length,
		0,
		"the cascaded membership lands in the member slice",
	);
	await unmount(root, container);
});

test("rename patches the snapshot and keeps the member count", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = mount(t, client, container, createElement(ContactGroupsManager, { mailboxId: "mb-1" }));
	await settle();
	const trigger = [...container.querySelectorAll("button")].find((b) =>
		b.textContent.includes("contactGroups.manage"));
	await click(trigger);
	await settle();

	const renameButton = container.querySelector('button[aria-label="contactGroups.rename Family"]');
	await click(renameButton);
	const input = container.querySelector('input[aria-label="common.name"]');
	assert.equal(input.value, "Family");
	await setInputValue(input, "Home");
	const save = container.querySelector('button[aria-label="common.save"]');
	await click(save);
	await settle();

	const patch = requests.find((r) => r.method === "PATCH");
	assert.deepEqual(patch, {
		url: "/api/contacts/groups/g-1", method: "PATCH",
		payload: { mailboxId: "mb-1", name: "Home" },
	});
	assert.match(container.textContent, /Home/);
	assert.match(container.textContent, /contactGroups.memberCount 1/, "the cached count survives PATCH");
	await unmount(root, container);
});
