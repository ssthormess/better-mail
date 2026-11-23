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

const state = { members: [m1, m2], deleted: false, defer: null };

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
	if (state.defer && url.includes("/members") && method !== "GET") await state.defer;
	if (url === "/api/mailing-lists" && method === "GET") {
		return response({ lists: state.deleted ? [] : [listEntry()] });
	}
	if (url === "/api/mailing-lists/list-1" && method === "GET") {
		return state.deleted ? response({ error: "List not found" }, 404) : response(detail());
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
		state.deleted = true;
		return response({ ok: true });
	}
	return response({ error: "Unexpected route " + method + " " + url }, 500);
};
globalThis.__listsCacheTestRouter = { pushes: [], push(url) { this.pushes.push(url); } };

beforeEach(() => {
	state.members = [m1, m2];
	state.deleted = false;
	state.defer = null;
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
		export const Save = i, Pencil = i, Trash2 = i, UserPlus = i;`,
	"@/components/ui/badge": `import React from "react"; export function Badge({children,...p}){return React.createElement("span",p,children);}`,
	"@/components/ui/button": `import React from "react"; export const Button = React.forwardRef(function Button({children,size,variant,pill,asChild,...props},ref){return React.createElement("button",{...props,ref},children);});`,
	"@/components/ui/card": `import React from "react";
		export const Card = ({children,...p}) => React.createElement("div",p,children);
		export const CardContent = Card, CardHeader = Card, CardDescription = Card;
		export const CardTitle = ({children,...p}) => React.createElement("h2",p,children);`,
	"@/components/ui/checkbox": `import React from "react"; export const Checkbox = React.forwardRef(function Checkbox(props,ref){return React.createElement("input",{type:"checkbox",...props,ref});});`,
	"@/components/ui/confirm-dialog": `export function confirmDestructive(){return Promise.resolve(true);} export function confirmDialog(){return Promise.resolve(true);} export function alertDialog(){return Promise.resolve();}`,
	"@/components/ui/dialog": `import React from "react";
export function Dialog({open,onOpenChange,children}){
	return open ? React.createElement(React.Fragment,null,React.createElement("button",{type:"button","data-testid":"dismiss-dialog",onClick:()=>onOpenChange(false)},"dismiss"),children) : null;
}
export function DialogContent({children,onCloseAutoFocus,...props}){return React.createElement("div",props,children);}
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

async function mount(t, client, Page, container) {
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(createElement(QueryClientProvider, { client }, createElement(Page)));
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
	const del = [...detailContainer.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.delete"));
	await click(del);
	await settle();

	assert.deepEqual(globalThis.__listsCacheTestRouter.pushes, ["/settings/lists"]);
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
	state.defer = new Promise(r => { release = r; });

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

	await act(async () => { release(); state.defer = null; await new Promise(r => setTimeout(r, 30)); });
	const addAfter = [...container.querySelectorAll("button")].find(b => b.textContent.includes("mailingLists.addMember"));
	assert.equal(addAfter.disabled, false, "actions unlock after the write settles");
	assert.equal(container.querySelectorAll('button[aria-label="mailingLists.removeMember"]').length, 1);
	await unmount(root, container);
});
