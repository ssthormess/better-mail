import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

// Same cache discipline as the F10 mailing-list gate: the app's QueryClient
// disables refetchOnMount/reconnect/focus, so mutations must write the groups
// snapshot themselves; all group and member writes share one scope; and a
// member PATCH response carries no memberCount, so the cache keeps its own.

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
	nextGroupId: 3,
	deferIndex: null,
	deferMembers: null,
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
	if (path === "/api/contacts/groups" && method === "GET") {
		// Capture before deferring — a delayed response still returns the pre-request snapshot.
		const data = { groups: sortedGroups().map(groupEntry) };
		if (state.deferIndex) await state.deferIndex;
		return response(data);
	}
	if (path === "/api/contacts/groups" && method === "POST") {
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
	state.deferIndex = state.deferMembers = null;
	requests.length = 0;
});

const tStub = `export function useLanguage() {
	return { t(key, vars) {
		if (vars && vars.count !== undefined) return key + " " + vars.count;
		if (vars && vars.name !== undefined) return key + " " + vars.name;
		return key;
	} };
}`;

const uiStubs = {
	"@/components/language-provider": tStub,
	"@/lib/auth/client": `export function authFetch(...args){return globalThis.__groupsCacheTestFetch(...args);}`,
	"@/components/icons": `import React from "react"; const i = () => null;
		export const Check = i, Pencil = i, Tags = i, Trash2 = i, X = i, Tag01 = i;`,
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
};

const { ContactGroupsManager } = await loadComponent("src/components/contacts/contact-groups-manager.tsx", uiStubs);
const { ContactGroupsDialog } = await loadComponent("src/components/contacts/contact-groups-dialog.tsx", uiStubs);
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

async function mountManager(t, client, container) {
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(
			createElement(QueryClientProvider, { client }, createElement(ContactGroupsManager, { mailboxId: "mb-1" })),
		);
	});
	return reactRoot;
}

async function mountAssignDialog(t, client, container) {
	const reactRoot = createRoot(container);
	const props = { mailboxId: "mb-1", contact, open: true, onOpenChange: () => {} };
	await act(async () => {
		reactRoot.render(
			createElement(QueryClientProvider, { client }, createElement(ContactGroupsDialog, props)),
		);
	});
	return reactRoot;
}

async function unmount(reactRoot, container) {
	await act(async () => reactRoot.unmount());
	container.remove();
}

async function settle() {
	await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
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

async function openManager(container) {
	const trigger = [...container.querySelectorAll("button")].find((b) =>
		b.textContent.includes("contactGroups.manage"));
	await click(trigger);
}

test("the manager lists groups with member counts and creates one in sorted order", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = await mountManager(t, client, container);
	await settle();
	await openManager(container);

	assert.match(container.textContent, /Family/);
	assert.match(container.textContent, /contactGroups.memberCount 1/, "Family shows one member");
	assert.match(container.textContent, /Work/);
	assert.match(container.textContent, /contactGroups.memberCount 0/, "Work shows zero members");

	const input = container.querySelector('input[aria-label="contactGroups.new"]');
	await setInputValue(input, "Beta");
	const createButton = [...container.querySelectorAll("button")].find((b) =>
		b.textContent === "contactGroups.create");
	await click(createButton);
	await settle();

	assert.deepEqual(
		requests.find((r) => r.method === "POST"),
		{ url: "/api/contacts/groups", method: "POST", payload: { mailboxId: "mb-1", name: "Beta" } },
	);
	// Server order is lower(name): Beta lands before Family, before Work.
	const text = container.textContent;
	assert.ok(text.indexOf("Beta") < text.indexOf("Family") && text.indexOf("Family") < text.indexOf("Work"));
	await unmount(root, container);
});

test("rename patches the snapshot and keeps the member count", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = await mountManager(t, client, container);
	await settle();
	await openManager(container);

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

test("deleting a group removes it and its member slice from the snapshot", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = await mountManager(t, client, container);
	await settle();
	await openManager(container);

	const remove = container.querySelector('button[aria-label="contactGroups.deleteFor Family"]');
	await click(remove);
	await settle();

	const del = requests.find((r) => r.method === "DELETE");
	assert.deepEqual(del, { url: "/api/contacts/groups/g-1?mailboxId=mb-1", method: "DELETE", payload: null });
	assert.doesNotMatch(container.textContent, /Family/);
	const cached = client.getQueryData(["contact-groups", "mb-1"]);
	assert.equal(cached.groups.length, 1);
	assert.equal(cached.membersByGroup["g-1"], undefined, "the member slice is dropped too");
	await unmount(root, container);
});

test("the assign dialog toggles membership and updates the cached count", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = await mountAssignDialog(t, client, container);
	await settle();

	const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
	assert.equal(boxes.length, 2);
	assert.equal(boxes[0].checked, true, "Family is checked — the contact is a member");
	assert.equal(boxes[1].checked, false, "Work is unchecked");

	await click(boxes[1]);
	await settle();
	const post = requests.find((r) => r.method === "POST" && r.url.includes("/members"));
	assert.deepEqual(post, {
		url: "/api/contacts/groups/g-2/members", method: "POST",
		payload: { mailboxId: "mb-1", contactId: "c-1" },
	});
	let cached = client.getQueryData(["contact-groups", "mb-1"]);
	assert.equal(cached.groups.find((g) => g.id === "g-2").memberCount, 1);
	assert.equal(cached.membersByGroup["g-2"].length, 1);

	await click(boxes[0]);
	await settle();
	const del = requests.find((r) => r.method === "DELETE" && r.url.includes("/members"));
	assert.equal(
		del.url,
		"/api/contacts/groups/g-1/members?mailboxId=mb-1&contactId=c-1",
	);
	cached = client.getQueryData(["contact-groups", "mb-1"]);
	assert.equal(cached.groups.find((g) => g.id === "g-1").memberCount, 0);
	assert.equal(cached.membersByGroup["g-1"].length, 0);
	await unmount(root, container);
});

test("a member write landing on a dropped cache restarts the in-flight GET", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	const container = newContainer(t);
	const root = await mountAssignDialog(t, client, container);
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
	client.removeQueries({ queryKey: ["contact-groups", "mb-1"] });

	// Revisiting starts a cold GET while the write is still in flight.
	let releaseIndex;
	state.deferIndex = new Promise((r) => { releaseIndex = r; });
	const container2 = newContainer(t);
	const root2 = await mountAssignDialog(t, client, container2);
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

	// The write lands: it cancels the cold GET, finds no snapshot, and must restart it.
	await act(async () => { releaseWrite(); state.deferMembers = null; await new Promise((r) => setTimeout(r, 20)); });
	assert.equal(client.isMutating(), 0, "the write settles without waiting on the restarted GET");
	await act(async () => { releaseIndex(); state.deferIndex = null; await new Promise((r) => setTimeout(r, 30)); });

	const cached = client.getQueryData(["contact-groups", "mb-1"]);
	assert.ok(cached, "the groups query is not stranded pending");
	assert.equal(cached.membersByGroup["g-2"].length, 1, "the restarted GET returns post-write data");
	await unmount(root2, container2);
});

test("two rapid toggles produce a single member write", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	let release;
	state.deferMembers = new Promise((r) => { release = r; });
	const container = newContainer(t);
	const root = await mountAssignDialog(t, client, container);
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

test("a create during the first load survives the cancelled index GET", async (t) => {
	const client = testClient();
	t.after(() => client.clear());
	let releaseIndex;
	state.deferIndex = new Promise((r) => { releaseIndex = r; });

	const container = newContainer(t);
	const root = await mountManager(t, client, container);
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	await openManager(container);

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
	assert.ok(cached.groups.some((entry) => entry.name === "Beta"), "the created group survives the late GET");
	await unmount(root, container);
});
