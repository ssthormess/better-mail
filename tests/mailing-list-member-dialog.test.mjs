import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

// The member dialog must keep edit-mode semantics straight: the API cannot change a
// member's email (field stays locked) and PATCH must carry memberId; conflicts (409)
// surface the server's message instead of a generic failure.

const member = {
	id: "m-1",
	listId: "list-1",
	email: "ada@example.com",
	name: "Ada",
	role: "member",
	moderated: false,
	createdAt: "2026-01-01T00:00:00.000Z",
};

const mock = {
	"@/components/language-provider": `export function useLanguage() { return { t(key) { return key; } }; }`,
	"@/lib/auth/client": `export function authFetch(...args) { return globalThis.__listsTestFetch(...args); }`,
	"@/components/ui/button": `import React from "react"; export function Button({children,size,variant,pill,...props}){return React.createElement("button",props,children);}`,
	"@/components/ui/checkbox": `import React from "react"; export const Checkbox = React.forwardRef(function Checkbox(props,ref){return React.createElement("input",{type:"checkbox",...props,ref});});`,
	"@/components/ui/dialog": `import React from "react";
export function Dialog({open,onOpenChange,children}){return open ? React.createElement(React.Fragment,null,children) : null;}
export function DialogContent({children,...props}){return React.createElement("div",props,children);}
export function DialogHeader({children}){return React.createElement("div",null,children);}
export function DialogTitle({children}){return React.createElement("h2",null,children);}
export function DialogDescription({children}){return React.createElement("p",null,children);}`,
	"@/components/ui/input": `import React from "react"; export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});`,
	"@/components/ui/label": `import React from "react"; export function Label({children,...props}){return React.createElement("label",props,children);}`,
	"@/components/ui/select": `import React from "react";
export const Select = React.forwardRef(function Select({children,containerClassName,onChange,...props},ref){
	return React.createElement("select",{...props,ref,onChange: e => onChange && onChange({target:{value:e.target.value}})},children);
});`,
};

// The real MemberDialog and real [id]/utils.ts calls; only the network, translations
// and plain UI pieces are stubbed.
const { MemberDialog } = await loadComponent("src/app/(settings)/settings/lists/[id]/member-dialog.tsx", mock);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const requests = [];
globalThis.__listsTestFetch = async (url, options = {}) => {
	const method = options.method || "GET";
	const payload = options.body ? JSON.parse(options.body) : null;
	requests.push({ url, method, payload });
	if (url === "/api/mailing-lists/list-1/members" && method === "PATCH") {
		return response({ members: [{ ...member, ...payload, id: member.id }] });
	}
	if (url === "/api/mailing-lists/list-1/members" && method === "POST") {
		return response({ error: "That address is already a member of this list" }, 409);
	}
	return response({ error: "Unexpected route" }, 500);
};
beforeEach(() => { requests.length = 0; });

function response(data, status = 200) {
	return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

async function renderDialog(t, memberProp) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	const client = new QueryClient();
	const closed = [];
	const props = { listId: "list-1", member: memberProp, open: true, onOpenChange: next => closed.push(next) };
	t.after(async () => {
		await act(async () => reactRoot.unmount());
		container.remove();
	});
	await act(async () => {
		reactRoot.render(createElement(QueryClientProvider, { client }, createElement(MemberDialog, props)));
	});
	return { container, closed };
}

async function setInputValue(input, value) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

async function click(element) {
	await act(async () => {
		element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 10)); // let the mutation finish
	});
}

test("editing a member PATCHes memberId with the edited fields", async t => {
	const { container, closed } = await renderDialog(t, member);
	const email = container.querySelector("#member-email");
	assert.equal(email.value, "ada@example.com");
	assert.equal(email.disabled, true, "email stays locked — the API cannot change it");

	await setInputValue(container.querySelector("#member-name"), "Ada Lovelace");
	await click(container.querySelector('input[type="checkbox"]'));

	const save = [...container.querySelectorAll("button")].find(b => b.textContent === "common.save");
	assert.ok(save, "the Save button is rendered");
	await click(save);

	assert.deepEqual(requests, [{
		url: "/api/mailing-lists/list-1/members",
		method: "PATCH",
		payload: { memberId: "m-1", name: "Ada Lovelace", role: "member", moderated: true },
	}]);
	assert.deepEqual(closed, [false], "the dialog closes after a successful save");
});

test("adding a duplicate member surfaces the API's conflict message", async t => {
	const { container, closed } = await renderDialog(t, undefined);
	const email = container.querySelector("#member-email");
	assert.equal(email.disabled, false, "email is editable when adding a member");

	await setInputValue(email, "dupe@example.com");
	const save = [...container.querySelectorAll("button")].find(b => b.textContent === "common.save");
	await click(save);

	assert.deepEqual(requests, [{
		url: "/api/mailing-lists/list-1/members",
		method: "POST",
		payload: { email: "dupe@example.com", role: "member", moderated: false },
	}]);
	const alert = container.querySelector('[role="alert"]');
	assert.ok(alert, "an alert is shown");
	assert.match(alert.textContent, /already a member/, "the server's 409 message is shown verbatim");
	assert.deepEqual(closed, [], "the dialog stays open on conflict");
});
