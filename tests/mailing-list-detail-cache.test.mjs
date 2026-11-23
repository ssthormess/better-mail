import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

// Cache regressions from the F10 gate review. The app's QueryClient disables
// refetchOnMount/reconnect/focus, so mutations must write the index snapshot
// themselves; member writes are serialized; and a member-driven list update
// must never wipe an unsaved settings draft.

const list1 = {
	id: "list-1", userId: "u-1", domainId: "d-1", localPart: "team",
	hostname: "example.com", address: "team@example.com", name: "Original",
	description: null, postingPolicy: "members_only", moderated: false,
	disabled: false, createdAt: "2026-01-01T00:00:00.000Z",
};
const m1 = { id: "m-1", listId: "list-1", email: "one@example.com", name: null, role: "member", moderated: false, createdAt: "2026-01-01T00:00:00.000Z" };
const m2 = { ...m1, id: "m-2", email: "two@example.com" };
const m3 = { ...m1, id: "m-3", email: "three@example.com" };

const state = {
	members: [m1, m2], created: [], deleted: false, failIndex: false,
	deferMembers: null, deferIndex: null, deferDetail: null, deferList: null,
};

const listEntry = () => ({ ...list1, memberCount: state.members.length });
const detail = () => ({ list: listEntry(), members: [...state.members] });

function response(data, status = 200) {
	return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

const requests = [];
globalThis.__listsCacheTestFetch = async (url, options = {}) => {
	const method = options.method || "GET";
	const payload = options.body ? JSON.parse(options.body) : null;
	requests.push({ url, method, payload });
	if (state.deferMembers && url.includes("/members") && method !== "GET") await state.deferMembers;
	if (url === "/api/domains" && method === "GET") {
		return response({ domains: [
			{ id: "d-1", hostname: "example.com", status: "active" },
			{ id: "d-2", hostname: "pending.example", status: "pending" },
		] });
	}
	if (url === "/api/mailing-lists" && method === "GET") {
		// Capture before deferring — a delayed response still returns the pre-request snapshot.
		const data = state.deleted ? { lists: [] } : { lists: [listEntry(), ...state.created] };
		if (state.deferIndex) await state.deferIndex;
		return state.failIndex ? response({ error: "index down" }, 500) : response(data);
	}
	if (url === "/api/mailing-lists" && method === "POST") {
		const list = {
			id: `list-${state.created.length + 2}`, userId: "u-1", domainId: payload.domainId,
			localPart: payload.localPart, hostname: "example.com",
			address: `${payload.localPart}@example.com`, name: payload.name,
			description: payload.description ?? null, postingPolicy: payload.postingPolicy,
			moderated: payload.moderated, disabled: false,
			createdAt: "2026-01-01T00:00:00.000Z", memberCount: 0,
		};
		state.created.push(list);
		return response({ list });
	}
	if (url === "/api/mailing-lists/list-1" && method === "GET") {
		const data = state.deleted ? null : detail();
		if (state.deferDetail) await state.deferDetail;
		return data ? response(data) : response({ error: "List not found" }, 404);
	}
	if (url === "/api/mailing-lists/list-1/members" && method === "POST") {
		state.members = [...state.members, { ...m3, ...payload, id: `m-${state.members.length + 1}`, email: payload.email }];
		return response({ members: [...state.members] });
	}
	if (url === "/api/mailing-lists/list-1/members" && method === "PATCH") {
		state.members = state.members.map(m => (m.id === payload.memberId ? { ...m, ...payload } : m));
		return response({ members: [...state.members] });
	}
	if (url.startsWith("/api/mailing-lists/list-1/members") && method === "DELETE") {
		const memberId = new URL(url, "https://mail.example").searchParams.get("memberId");
		state.members = state.members.filter(m => m.id !== memberId);
		return response({ members: [...state.members] });
	}
	if (url === "/api/mailing-lists/list-1" && method === "DELETE") {
		if (state.deferList) await state.deferList;
		state.deleted = true;
		return response({ ok: true });
	}
	return response({ error: "Unexpected route " + method + " " + url }, 500);
};
globalThis.__listsCacheTestRouter = { pushes: [], push(url) { this.pushes.push(url); } };

beforeEach(() => {
	state.members = [m1, m2];
	state.created = [];
	state.deleted = false;
	state.failIndex = false;
	state.deferMembers = state.deferIndex = state.deferDetail = state.deferList = null;
	requests.length = 0;
	globalThis.__listsCacheTestRouter.pushes.length = 0;
});

const tStub = `export function useLanguage() {
	return { t(key, vars) { return vars && vars.count !== undefined ? key + " " + vars.count : key; } };
}`;

const uiStubs = {
	"next/navigation": `export function useParams(){return {id:"list-1"};} export function useRouter(){return globalThis.__listsCacheTestRouter;}`,
	"@/components/language-provider": tStub,
	"@/lib/auth/client": `export function authFetch(...args){return globalThis.__listsCacheTestFetch(...args);}`,
	"@/components/icons": `import React from "react"; const i = () => null;
		export const Save = i, Pencil = i, Trash2 = i, UserPlus = i, Plus = i, Users = i;`,
	"@/components/ui/badge": `import React from "react"; export function Badge({children,...p}){return React.createElement("span",p,children);}`,
	"@/components/ui/button": `import React from "react"; export const Button = React.forwardRef(function Button({children,size,variant,pill,asChild,...props},ref){return React.createElement("button",{...props,ref},children);});`,
	"@/components/ui/card": `import React from "react";
		export const Card = ({children,...p}) => React.createElement("div",p,children);
		export const CardContent = Card, CardHeader = Card, CardDescription = Card;
		export const CardTitle = ({children,...p}) => React.createElement("h2",p,children);`,
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
	const {open,onOpenChange} = React.useContext(DialogCtx);
	const wasOpen = React.useRef(open);
	React.useEffect(()=>{
		if (wasOpen.current && !open && onCloseAutoFocus) onCloseAutoFocus(new window.Event("closeAutoFocus"));
		wasOpen.current = open;
	},[open,onCloseAutoFocus]);
	return open ? React.createElement("div",props,React.createElement("button",{type:"button","data-testid":"dismiss-dialog",onClick:()=>onOpenChange(false)},"dismiss"),children) : null;
}
export function DialogHeader({children}){return React.createElement("div",null,children);}
export function DialogTitle({children}){return React.createElement("h2",null,children);}
export function DialogDescription({children}){return React.createElement("p",null,children);}`,
	"@/components/ui/input": `import React from "react"; export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});`,
	"@/components/ui/label": `import React from "react"; export function Label({children,...props}){return React.createElement("label",props,children);}`,
	"@/components/ui/select": `import React from "react";
export const Select = React.forwardRef(function Select({children,containerClassName,onChange,...props},ref){
	return React.createElement("select",{...props,ref,onChange:e=>onChange&&onChange({target:{value:e.target.value}})},children);
});`,
	"@/components/ui/skeleton": `import React from "react"; export function Skeleton(props){return React.createElement("div",props);}`,
	"@/components/ui/textarea": `import React from "react"; export const Textarea = React.forwardRef(function Textarea(props,ref){return React.createElement("textarea",{...props,ref});});`,
};

const indexStubs = {
	...uiStubs,
	"next/link": `import React from "react"; export default function Link({href,children,...p}){return React.createElement("a",{href,...p},children);}`,
	"./list-create-dialog": `import React from "react"; export function ListCreateDialog(){return null;}`,
	"@/components/ui/list": `import React from "react"; export const List = ({children,...p})=>React.createElement("div",p,children); export const ListRow = ({children,asChild,...p})=>React.createElement("div",p,children);`,
	"@/components/page-skeletons": `import React from "react"; export function SectionRowSkeleton(){return React.createElement("div");}`,
	"@/components/icons": `import React from "react"; const i = () => null; export const Users = i;`,
};

const { default: MailingListDetailPage } = await loadComponent("src/app/(settings)/settings/lists/[id]/page.tsx", uiStubs);
const { default: MailingListsPage } = await loadComponent("src/app/(settings)/settings/lists/page.tsx", indexStubs);
// The real create dialog (the index page stub replaces its own copy) so a create can
// race the initial index GET.
const { ListCreateDialog } = await loadComponent("src/app/(settings)/settings/lists/list-create-dialog.tsx", {
	...uiStubs,
	"@/components/page-header-utils": `export const mobilePrimaryActionAboveNavClass = "";`,
});
const { createElement, act, Fragment } = await import("react");
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

async function mount(t, client, Page, container) {
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(createElement(QueryClientProvider, { client }, createElement(Page)));
	});
	return reactRoot;
}

async function mountNode(t, client, node, container) {
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(createElement(QueryClientProvider, { client }, node));
	});
	return reactRoot;
}

async function unmount(reactRoot, container) {
	await act(async () => reactRoot.unmount());
	container.remove();
}

async function settle() {
	await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

async function click(element) {
	await act(async () => {
		element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise(r => setTimeout(r, 10));
	});
}

async function setInputValue(input, value) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

async function setSelectValue(select, value) {
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value").set;
	await act(async () => {
		setter.call(select, value);
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}

function newContainer(t) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	t.after(() => container.remove());
	return container;
}

test("index remount under provider options shows the count from a member add", async t => {
	const client = testClient();
	t.after(() => client.clear());

	// Visit the index, then navigate away — the observer goes inactive.
	const indexContainer = newContainer(t);
	const indexRoot = await mount(t, client, MailingListsPage, indexContainer);
	await settle();
	assert.match(indexContainer.textContent, /mailingLists.memberCount 2/);
	await unmount(indexRoot, indexContainer);

	// On the detail page, add a member.
	const detailContainer = newContainer(t);
	const detailRoot = await mount(t, client, MailingListDetailPage, detailContainer);
	await settle();
	const addButton = [...detailContainer.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.addMember"));
	await click(addButton);
	await setInputValue(detailContainer.querySelector("#member-email"), "three@example.com");
	const save = [...detailContainer.querySelectorAll("button")].find(b => b.textContent === "common.save");
	await click(save);
	await settle();
	await unmount(detailRoot, detailContainer);

	// Back on the index: remount must not resurrect the stale count.
	const index2 = newContainer(t);
	const index2Root = await mount(t, client, MailingListsPage, index2);
	await settle();
	assert.match(index2.textContent, /mailingLists.memberCount 3/, "the index reflects the added member");
	await unmount(index2Root, index2);
});

test("deleting a list drops it from the index and clears its detail cache", async t => {
	const client = testClient();
	t.after(() => client.clear());

	const indexContainer = newContainer(t);
	const indexRoot = await mount(t, client, MailingListsPage, indexContainer);
	await settle();
	assert.match(indexContainer.textContent, /team@example.com/);
	await unmount(indexRoot, indexContainer);

	const detailContainer = newContainer(t);
	const detailRoot = await mount(t, client, MailingListDetailPage, detailContainer);
	await settle();
	// Hold the scheduled index refresh — the redirect must not wait on it.
	let releaseIndex;
	state.deferIndex = new Promise(r => { releaseIndex = r; });
	const del = [...detailContainer.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.delete"));
	await click(del);
	await settle();

	assert.deepEqual(globalThis.__listsCacheTestRouter.pushes, ["/settings/lists"], "redirects without waiting on the held GET");
	await act(async () => { releaseIndex(); state.deferIndex = null; await new Promise(r => setTimeout(r, 30)); });
	assert.equal(client.getQueryData(["mailing-list", "list-1"]), undefined, "the detail cache is dropped");
	await unmount(detailRoot, detailContainer);

	const index2 = newContainer(t);
	const index2Root = await mount(t, client, MailingListsPage, index2);
	await settle();
	assert.doesNotMatch(index2.textContent, /team@example.com/, "the deleted list is gone from the index");
	await unmount(index2Root, index2);
});

test("an unsaved settings draft survives a member remove", async t => {
	const client = testClient();
	t.after(() => client.clear());

	const container = newContainer(t);
	const root = await mount(t, client, MailingListDetailPage, container);
	await settle();

	const nameInput = container.querySelector("#list-edit-name");
	assert.equal(nameInput.value, "Original");
	await setInputValue(nameInput, "Unsaved draft");

	const remove = container.querySelector('button[aria-label="mailingLists.removeMember"]');
	await click(remove);
	await settle();

	assert.equal(container.querySelectorAll('button[aria-label="mailingLists.removeMember"]').length, 1, "one member was removed");
	assert.equal(container.querySelector("#list-edit-name").value, "Unsaved draft", "the dirty draft is kept");
	await unmount(root, container);
});

test("member actions are disabled while a member write is in flight", async t => {
	const client = testClient();
	t.after(() => client.clear());
	let release;
	state.deferMembers = new Promise(r => { release = r; });

	const container = newContainer(t);
	const root = await mount(t, client, MailingListDetailPage, container);
	await settle();

	const remove = container.querySelector('button[aria-label="mailingLists.removeMember"]');
	await act(async () => { remove.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(r => setTimeout(r, 10)); });

	const addButton = [...container.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.addMember"));
	assert.equal(addButton.disabled, true, "add is blocked while a remove is pending");
	for (const btn of container.querySelectorAll('button[aria-label="mailingLists.removeMember"], button[aria-label="mailingLists.editMember"]')) {
		assert.equal(btn.disabled, true, "every member action is blocked while a write is pending");
	}
	const deleteButton = [...container.querySelectorAll("button")].find(b => b.textContent === "mailingLists.delete");
	assert.equal(deleteButton.disabled, true, "the list delete is blocked while a member write is pending");

	await act(async () => { release(); state.deferMembers = null; await new Promise(r => setTimeout(r, 30)); });
	const addAfter = [...container.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.addMember"));
	assert.equal(addAfter.disabled, false, "actions unlock after the write settles");
	assert.equal(container.querySelectorAll('button[aria-label="mailingLists.removeMember"]').length, 1);
	await unmount(root, container);
});

test("a create during the first index load survives the stale GET landing last", async t => {
	const client = testClient();
	t.after(() => client.clear());
	let releaseIndex;
	state.deferIndex = new Promise(r => { releaseIndex = r; });

	// The index page mounts and its GET is still in flight when the create finishes.
	const container = newContainer(t);
	const root = await mountNode(t, client, createElement(Fragment, null,
		createElement(MailingListsPage), createElement(ListCreateDialog)), container);
	await act(async () => { await new Promise(r => setTimeout(r, 10)); });

	const trigger = [...container.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.new"));
	await click(trigger);
	await settle(); // domains GET resolves inside the open dialog
	await setInputValue(container.querySelector("#list-name"), "Crew");
	await setInputValue(container.querySelector("#list-localpart"), "crew");
	await setSelectValue(container.querySelector('select[aria-label="accounts.domain"]'), "d-1");
	const createButton = [...container.querySelectorAll("button")].find(b => b.textContent === "mailingLists.createButton");
	await click(createButton);
	await settle();

	assert.equal(container.querySelector("#list-localpart"), null, "the dialog closes without waiting for the held GET");
	// The stale first-load response lands now — after the mutation already applied.
	await act(async () => { releaseIndex(); state.deferIndex = null; await new Promise(r => setTimeout(r, 30)); });

	assert.match(container.textContent, /crew@example.com/, "the created list is visible despite the late GET");
	const cached = client.getQueryData(["mailing-lists"]);
	assert.ok(cached.lists.some(entry => entry.address === "crew@example.com"), "the index cache holds the created list");
	await unmount(root, container);
});

test("a member write does not synthesize an index row for a missing id", async t => {
	const client = testClient();
	t.after(() => client.clear());
	// The index snapshot predates this list (or the list was deleted): a count patch
	// must not append a partial row. The failing refetch leaves whatever was written.
	state.failIndex = true;
	client.setQueryData(["mailing-lists"], { lists: [{ ...list1, id: "list-9", address: "other@example.com" }] });

	const container = newContainer(t);
	const root = await mount(t, client, MailingListDetailPage, container);
	await settle();
	const remove = container.querySelector('button[aria-label="mailingLists.removeMember"]');
	await click(remove);
	await settle();

	const cached = client.getQueryData(["mailing-lists"]);
	assert.equal(cached.lists.length, 1, "no synthesized row");
	assert.equal(cached.lists[0].id, "list-9");
	await unmount(root, container);
});

test("a member write landing on a dropped detail cache restarts the in-flight GET", async t => {
	const client = testClient();
	t.after(() => client.clear());

	const container = newContainer(t);
	const root = await mount(t, client, MailingListDetailPage, container);
	await settle();

	let releaseRemove;
	state.deferMembers = new Promise(r => { releaseRemove = r; });
	const remove = container.querySelector('button[aria-label="mailingLists.removeMember"]');
	await act(async () => { remove.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(r => setTimeout(r, 10)); });

	// The page navigates away mid-write and its inactive detail cache is evicted.
	await unmount(root, container);
	client.removeQueries({ queryKey: ["mailing-list", "list-1"] });

	// Revisiting the route starts a cold GET while the member write is still in flight.
	let releaseDetail;
	state.deferDetail = new Promise(r => { releaseDetail = r; });
	const container2 = newContainer(t);
	const root2 = await mount(t, client, MailingListDetailPage, container2);
	await act(async () => { await new Promise(r => setTimeout(r, 10)); });

	// The write lands: it cancels the cold GET, finds no snapshot, and must restart it.
	await act(async () => { releaseRemove(); state.deferMembers = null; await new Promise(r => setTimeout(r, 20)); });
	assert.equal(client.isMutating(), 0, "the write settles without waiting on the restarted GET");
	await act(async () => { releaseDetail(); state.deferDetail = null; await new Promise(r => setTimeout(r, 30)); });

	const cached = client.getQueryData(["mailing-list", "list-1"]);
	assert.ok(cached, "the detail query is not stranded pending");
	assert.equal(cached.members.length, 1, "the restarted GET returns post-write data");
	assert.equal(container2.querySelectorAll('button[aria-label="mailingLists.removeMember"]').length, 1);
	await unmount(root2, container2);
});

test("two rapid removes produce a single member DELETE", async t => {
	const client = testClient();
	t.after(() => client.clear());
	let release;
	state.deferMembers = new Promise(r => { release = r; });

	const container = newContainer(t);
	const root = await mount(t, client, MailingListDetailPage, container);
	await settle();

	const removes = container.querySelectorAll('button[aria-label="mailingLists.removeMember"]');
	// Both clicks land before the first confirmation resolves — only one write may start.
	await act(async () => {
		removes[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		removes[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise(r => setTimeout(r, 30));
	});

	const deletes = requests.filter(r => r.method === "DELETE" && r.url.includes("/members"));
	assert.equal(deletes.length, 1, "the async confirmation rechecks the write scope");

	await act(async () => { release(); state.deferMembers = null; await new Promise(r => setTimeout(r, 30)); });
	await unmount(root, container);
});

test("member actions are disabled while the list delete is in flight", async t => {
	const client = testClient();
	t.after(() => client.clear());
	let release;
	state.deferList = new Promise(r => { release = r; });

	const container = newContainer(t);
	const root = await mount(t, client, MailingListDetailPage, container);
	await settle();

	const deleteButton = [...container.querySelectorAll("button")].find(b => b.textContent === "mailingLists.delete");
	await act(async () => { deleteButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(r => setTimeout(r, 10)); });

	const addButton = [...container.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.addMember"));
	assert.equal(addButton.disabled, true, "member actions are blocked while the delete is pending");
	for (const btn of container.querySelectorAll('button[aria-label="mailingLists.removeMember"], button[aria-label="mailingLists.editMember"]')) {
		assert.equal(btn.disabled, true);
	}

	await act(async () => { release(); state.deferList = null; await new Promise(r => setTimeout(r, 30)); });
	assert.deepEqual(globalThis.__listsCacheTestRouter.pushes, ["/settings/lists"]);
	await unmount(root, container);
});

test("closing a dialog while a write is pending moves focus to a focusable fallback", async t => {
	const client = testClient();
	t.after(() => client.clear());

	const container = newContainer(t);
	const root = await mount(t, client, MailingListDetailPage, container);
	await settle();

	// Plain dismiss: focus returns to the opener.
	const addButton = [...container.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.addMember"));
	await click(addButton);
	await click(container.querySelector('[data-testid="dismiss-dialog"]'));
	assert.equal(document.activeElement, addButton, "an enabled opener gets focus back");

	// Dismiss while a save is pending: the disabled opener cannot take focus.
	let release;
	state.deferMembers = new Promise(r => { release = r; });
	await click(addButton);
	await setInputValue(container.querySelector("#member-email"), "new@example.com");
	const save = [...container.querySelectorAll("button")].find(b => b.textContent === "common.save");
	await click(save);
	assert.equal(addButton.disabled, true, "the opener is disabled while the save is in flight");
	await click(container.querySelector('[data-testid="dismiss-dialog"]'));

	const fallback = container.querySelector('[tabindex="-1"]');
	assert.equal(document.activeElement, fallback, "focus lands on the card fallback instead of the disabled opener");

	await act(async () => { release(); state.deferMembers = null; await new Promise(r => setTimeout(r, 30)); });
	await unmount(root, container);
});

test("member controls re-enable while the post-write index refresh is still in flight", async t => {
	const client = testClient();
	t.after(() => client.clear());

	// Warm index first so the scheduled refresh is a real GET we can hold.
	const indexContainer = newContainer(t);
	const indexRoot = await mount(t, client, MailingListsPage, indexContainer);
	await settle();
	assert.match(indexContainer.textContent, /team@example.com/);
	let releaseIndex;
	state.deferIndex = new Promise(r => { releaseIndex = r; });

	const detailContainer = newContainer(t);
	const detailRoot = await mount(t, client, MailingListDetailPage, detailContainer);
	await settle();
	const remove = detailContainer.querySelector('button[aria-label="mailingLists.removeMember"]');
	await click(remove);
	await settle();

	// The write committed; the scheduled index GET is still held.
	assert.equal(client.isMutating(), 0, "the write is not pending on the refresh GET");
	const addButton = [...detailContainer.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.addMember"));
	assert.equal(addButton.disabled, false, "member actions re-enable while the GET is held");
	const deleteButton = [...detailContainer.querySelectorAll("button")].find(b => b.textContent === "mailingLists.delete");
	assert.equal(deleteButton.disabled, false, "delete re-enables while the GET is held");
	assert.equal(detailContainer.querySelectorAll('button[aria-label="mailingLists.removeMember"]').length, 1);

	await act(async () => { releaseIndex(); state.deferIndex = null; await new Promise(r => setTimeout(r, 30)); });
	await unmount(detailRoot, detailContainer);
	await unmount(indexRoot, indexContainer);
});
