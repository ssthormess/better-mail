import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, beforeEach } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// The external-accounts settings card: list render, client-side validation, the PATCH password contract
// (absent = keep), the delegate 403 surface, bounded last_error display and the skipped summary.

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "external-accounts-ui-test-"));
after(() => {
	dom.window.close();
	rmSync(temp, { recursive: true, force: true });
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement", "HTMLSelectElement", "MutationObserver"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = new Map([
	["@/components/language-provider", `export function useLanguage() {
		return { locale: "en", t(key, vars) { return vars ? key + " " + JSON.stringify(vars) : key; } };
	}`],
	["@/lib/auth/client", `export function authFetch(...args) { return globalThis.__extUiTestFetch(...args); }`],
	["@/components/icons", `import { createElement } from "react";
	export const Server = () => createElement("i", null, "Server");
	export const Plus = () => createElement("i", null, "Plus");
	export const Pencil = () => createElement("i", null, "Pencil");
	export const Trash2 = () => createElement("i", null, "Trash2");`],
	["@/components/ui/dialog", `import { createElement } from "react";
	export function Dialog({ open, children }) { return open ? children : null; }
	export function DialogContent({ children }) { return createElement("div", { "data-dialog-content": true }, children); }
	export function DialogHeader(props) { return createElement("div", props, props.children); }
	export function DialogTitle(props) { return createElement("h2", props, props.children); }
	export function DialogDescription(props) { return createElement("p", props, props.children); }
	export const DialogTrigger = () => null;
	export const DialogClose = () => null;`],
	["@/components/ui/select", `import { createElement, forwardRef } from "react";
	export const Select = forwardRef(function Select({ children, value, onChange, disabled, containerClassName, className, ...rest }, ref) {
		return createElement("select", { ...rest, ref, value, disabled, className,
			onChange: (event) => onChange?.({ target: { value: event.target.value }, currentTarget: { value: event.target.value } }) }, children);
	});`],
	["@/components/ui/switch", `import { createElement } from "react";
	export function Switch({ checked, onCheckedChange, disabled, ...rest }) {
		return createElement("button", { ...rest, type: "button", role: "switch", "aria-checked": checked, disabled,
			onClick: () => onCheckedChange?.(!checked) });
	}`],
	["@/components/ui/confirm-dialog", `export function confirmDestructive() { return Promise.resolve(globalThis.__extUiConfirmResult ?? true); }
	export function confirmDialog() { return Promise.resolve(true); }
	export function alertDialog() { return Promise.resolve(); }
	export function ConfirmDialogHost() { return null; }`],
]);

const genericUI = `
import React from "react";
export function Button({children, size, variant, pill, ...props}) {return React.createElement("button",props,children);}
export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});
export const Textarea = React.forwardRef(function Textarea(props,ref){return React.createElement("textarea",{...props,ref});});
export function Label({children,...props}){return React.createElement("label",props,children);}
export function Checkbox(props){return React.createElement("input",{type:"checkbox",...props});}
export function Badge({children,...props}){return React.createElement("span",props,children);}
export function Skeleton(props){return React.createElement("div",{"data-skeleton":true,...props});}
export function Card({children,...props}){return React.createElement("section",props,children);}
export function CardContent({children,...props}){return React.createElement("div",props,children);}
export function CardDescription({children,...props}){return React.createElement("p",props,children);}
export function CardHeader({children,...props}){return React.createElement("div",props,children);}
export function CardTitle({children,...props}){return React.createElement("h3",props,children);}
`;

await build({
	stdin: {
		contents: `
			export { ExternalAccountsCard } from "./src/app/(admin)/mailboxes/[id]/ExternalAccountsCard.tsx";
			export * as extUtils from "./src/app/(admin)/mailboxes/[id]/external-accounts-utils.ts";
		`,
		sourcefile: "external-accounts-ui-test-entry.ts",
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(temp, "card.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	packages: "external",
	external: ["react", "react-dom", "react-dom/*"],
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "ext-ui-test-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, args => {
				if (mock.has(args.path)) return { path: args.path, namespace: "ext-ui-test-stub" };
				if (/^@\/components\/ui\//.test(args.path)) return { path: args.path, namespace: "ext-ui-generic-stub" };
				return undefined;
			});
			b.onLoad({ filter: /.*/, namespace: "ext-ui-test-stub" }, args => ({ contents: mock.get(args.path), loader: "tsx" }));
			b.onLoad({ filter: /.*/, namespace: "ext-ui-generic-stub" }, () => ({ contents: genericUI, loader: "tsx" }));
		},
	}],
	logLevel: "silent",
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ExternalAccountsCard, extUtils } = await import(pathToFileURL(join(temp, "card.mjs")).href);

const MAILBOX = "m-1";
const accountsUrl = `/api/mailboxes/${MAILBOX}/accounts`;
const requests = [];
let listResponse = { accounts: [] };
let listStatus = 200;

globalThis.__extUiTestFetch = async (url, options = {}) => {
	const method = options.method || "GET";
	const payload = options.body ? JSON.parse(options.body) : null;
	requests.push({ url, method, payload });
	if (url === accountsUrl && method === "GET") return response(listResponse, listStatus);
	if (url === accountsUrl && method === "POST") return response({ account: accountView(payload) }, 201);
	if (method === "PATCH") return response({ account: { ...accountView({}), ...payload } });
	if (method === "DELETE") return response({ ok: true });
	return response({ error: "Unexpected route" }, 500);
};

function accountView(overrides) {
	return {
		id: "ext-1", protocol: "imap", host: "imap.example.com", port: 993, tlsMode: "implicit-tls",
		username: "me@example.com", enabled: true, passwordSet: true,
		lastSyncedAt: null, lastError: null, skippedUids: [], skippedUidls: [],
		createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	requests.length = 0;
	listResponse = { accounts: [] };
	listStatus = 200;
	globalThis.__extUiConfirmResult = true;
});

function response(data, status = 200) {
	return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

async function renderCard(t) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
	t.after(async () => {
		await act(async () => reactRoot.unmount());
		client.clear(); // drops the cache GC timers that would otherwise pin the event loop
		container.remove();
	});
	await act(async () => {
		reactRoot.render(createElement(QueryClientProvider, { client }, createElement(ExternalAccountsCard, { mailboxId: MAILBOX })));
	});
	await waitFor(() => assert.ok(!container.querySelector("[data-skeleton]"), "list finished loading"));
	return container;
}

async function waitFor(check, attempts = 200) {
	for (let i = 0; i < attempts; i++) {
		try { check(); return; } catch (error) {
			if (i === attempts - 1) throw error;
			await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
		}
	}
}

async function click(element) {
	await act(async () => {
		element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 10));
	});
}

async function setValue(element, value) {
	const proto = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
		element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
	});
}

const buttonWithText = (container, text) => [...container.querySelectorAll("button")].find(b => b.textContent.includes(text));

test("the account list renders protocol, server, login and sync state", async (t) => {
	listResponse = { accounts: [
		accountView({ id: "ext-1" }),
		accountView({ id: "ext-2", protocol: "pop3", host: "pop.example.com", port: 110, username: "other", enabled: false, lastSyncedAt: new Date(Date.now() - 90 * 60_000).toISOString() }),
	] };
	const container = await renderCard(t);
	const text = container.textContent;
	assert.ok(text.includes("imap.example.com:993"), "imap host:port shown");
	assert.ok(text.includes("pop.example.com:110"), "pop3 host:port shown");
	assert.ok(text.includes("me@example.com"), "username shown");
	assert.ok(text.includes("IMAP"), "protocol badge shown");
	assert.ok(text.includes("POP3"), "pop3 badge shown");
	assert.ok(text.includes("mailbox.external.neverSynced"), "unsynced account says so");
	assert.ok(text.includes("mailbox.external.lastSync"), "synced account shows its age");
	assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), [`GET ${accountsUrl}`], "only the list was fetched");
});

test("the add form refuses empty and malformed input before any request", async (t) => {
	const container = await renderCard(t);
	requests.length = 0; // the initial list fetch is not the form's doing
	await click(buttonWithText(container, "mailbox.external.add"));
	const dialog = container.querySelector("[data-dialog-content]");
	assert.ok(dialog, "the add dialog opened");

	await click(buttonWithText(dialog, "mailbox.external.add"));
	assert.deepEqual(requests, [], "nothing was sent");
	assert.ok(dialog.textContent.includes("mailbox.external.invalidHost"), "host error shown");
	assert.ok(dialog.textContent.includes("mailbox.external.passwordRequired"), "password error shown");

	const host = dialog.querySelector("#external-host");
	await setValue(host, "not a host");
	await click(buttonWithText(dialog, "mailbox.external.add"));
	assert.deepEqual(requests, [], "a malformed host is still refused");
});

test("protocol and TLS mode re-seed the port, and a valid add posts the account draft", async (t) => {
	const container = await renderCard(t);
	await click(buttonWithText(container, "mailbox.external.add"));
	const dialog = container.querySelector("[data-dialog-content]");

	const protocol = dialog.querySelector("#external-protocol");
	const tls = dialog.querySelector("#external-tls");
	const port = dialog.querySelector("#external-port");
	assert.equal(port.value, "993", "imap+TLS defaults to 993");
	await setValue(protocol, "pop3");
	assert.equal(port.value, "995", "pop3+TLS defaults to 995");
	await setValue(tls, "starttls");
	assert.equal(port.value, "110", "pop3+STARTTLS defaults to 110");

	await setValue(dialog.querySelector("#external-host"), "pop.example.com");
	await setValue(dialog.querySelector("#external-username"), "me@example.com");
	await setValue(dialog.querySelector("#external-password"), "s3cret");
	await click(buttonWithText(dialog, "mailbox.external.add"));

	await waitFor(() => assert.ok(requests.some(r => r.method === "POST")));
	const post = requests.find(r => r.method === "POST");
	assert.equal(post.url, accountsUrl);
	assert.deepEqual(post.payload, {
		protocol: "pop3", host: "pop.example.com", port: 110, tlsMode: "starttls",
		username: "me@example.com", password: "s3cret",
	}, "the draft went out whole — no sync_cursor, no read-back fields");
	await waitFor(() => assert.equal(container.querySelector("[data-dialog-content]"), null, "dialog closed on success"));
	assert.ok(requests.filter(r => r.method === "GET").length >= 2, "the list refreshed");
});

test("editing omits the password when the field is left blank and sends it when filled", async (t) => {
	listResponse = { accounts: [accountView({ id: "ext-9" })] };
	const container = await renderCard(t);
	const edit = container.querySelector('button[aria-label*="mailbox.external.editAccount"]');
	assert.ok(edit, "edit button rendered");
	await click(edit);
	const dialog = container.querySelector("[data-dialog-content]");
	assert.ok(dialog, "the edit dialog opened");
	assert.equal(dialog.querySelector("#external-host").value, "imap.example.com", "prefilled from the account");
	assert.equal(dialog.querySelector("#external-password").value, "", "the stored password is never shown");

	await setValue(dialog.querySelector("#external-port"), "143");
	await setValue(dialog.querySelector("#external-tls"), "starttls");
	await click(buttonWithText(dialog, "settings.mailbox.saveChanges"));
	await waitFor(() => assert.ok(requests.some(r => r.method === "PATCH")));
	const patch = requests.find(r => r.method === "PATCH");
	assert.equal(patch.url, `${accountsUrl}/ext-9`);
	assert.equal("password" in patch.payload, false, "no password key when the box stayed empty");
	assert.equal(patch.payload.port, 143);
	assert.equal(patch.payload.tlsMode, "starttls");
	assert.equal("syncCursor" in patch.payload, false, "sync_cursor is never client-writable");
});

test("a filled password box re-sends a new password on PATCH", async (t) => {
	listResponse = { accounts: [accountView({ id: "ext-9" })] };
	const container = await renderCard(t);
	await click(container.querySelector('button[aria-label*="mailbox.external.editAccount"]'));
	const dialog = container.querySelector("[data-dialog-content]");
	await setValue(dialog.querySelector("#external-password"), "rotated-secret");
	await click(buttonWithText(dialog, "settings.mailbox.saveChanges"));
	await waitFor(() => assert.ok(requests.some(r => r.method === "PATCH")));
	assert.equal(requests.find(r => r.method === "PATCH").payload.password, "rotated-secret");
});

test("the enable switch PATCHes only the enabled flag", async (t) => {
	listResponse = { accounts: [accountView({ id: "ext-4" })] };
	const container = await renderCard(t);
	const toggle = container.querySelector('[role="switch"]');
	assert.equal(toggle.getAttribute("aria-checked"), "true");
	await click(toggle);
	await waitFor(() => assert.ok(requests.some(r => r.method === "PATCH")));
	assert.deepEqual(requests.find(r => r.method === "PATCH").payload, { enabled: false });
});

test("delete asks for confirmation first and removes the account", async (t) => {
	listResponse = { accounts: [accountView({ id: "ext-7" })] };
	const container = await renderCard(t);
	globalThis.__extUiConfirmResult = false;
	await click(container.querySelector('button[aria-label*="mailbox.external.removeAccount"]'));
	assert.deepEqual(requests.filter(r => r.method === "DELETE"), [], "no delete while unconfirmed");

	globalThis.__extUiConfirmResult = true;
	await click(container.querySelector('button[aria-label*="mailbox.external.removeAccount"]'));
	await waitFor(() => assert.ok(requests.some(r => r.method === "DELETE")));
	assert.equal(requests.find(r => r.method === "DELETE").url, `${accountsUrl}/ext-7`);
});

test("a delegate 403 surfaces the server message without rendering accounts", async (t) => {
	listStatus = 403;
	listResponse = { error: "You cannot change this mailbox" };
	const container = await renderCard(t);
	assert.ok(container.textContent.includes("You cannot change this mailbox"), "the API error is shown");
	assert.equal(container.querySelector('[role="switch"]'), null, "no account rows rendered");
});

test("last_error is displayed bounded and as text, never as markup", async (t) => {
	const longError = `<img src=x onerror=alert(1)> ${"A".repeat(400)}`;
	listResponse = { accounts: [accountView({ id: "ext-2", lastError: longError })] };
	const container = await renderCard(t);
	const errorEl = [...container.querySelectorAll("p")].find(p => p.getAttribute("title") === longError);
	assert.ok(errorEl, "the error line carries the full text in title only");
	assert.equal(errorEl.textContent.length, 161, "rendered error is truncated to the bound plus ellipsis");
	assert.ok(errorEl.textContent.endsWith("…"), "truncated with an ellipsis");
	assert.equal(container.querySelector("img"), null, "no markup was interpreted");
});

test("skipped messages surface as a bounded count summary", async (t) => {
	listResponse = { accounts: [
		accountView({ id: "ext-3", skippedUids: [12, 40, 233] }),
		accountView({ id: "ext-4", protocol: "pop3", host: "pop.example.com", skippedUidls: ["aa", "bb"] }),
	] };
	const container = await renderCard(t);
	const text = container.textContent;
	assert.ok(text.includes("mailbox.external.skipped"), "skipped summary shown");
	assert.ok(text.includes('"count":3'), "imap skipped count");
	assert.ok(text.includes('"count":2'), "pop3 skipped count");
	assert.ok(!text.includes('"count":0'), "empty lists stay quiet");
});

test("canManageExternalAccounts and the port/table helpers encode the API contract", async () => {
	const { canManageExternalAccounts, defaultExternalAccountPort, truncateAccountError, formatSyncAge, externalAccountLabel, validateExternalAccountDraft } = extUtils;
	assert.equal(canManageExternalAccounts({ permission: "full_access" }), true);
	assert.equal(canManageExternalAccounts({ permission: "read_only" }), false);
	assert.equal(canManageExternalAccounts({ permission: "send_as" }), false);
	assert.equal(canManageExternalAccounts({ permission: "send_on_behalf" }), false);
	assert.equal(canManageExternalAccounts({ permission: null }), false);
	assert.equal(canManageExternalAccounts(undefined), false);

	assert.equal(defaultExternalAccountPort("imap", "implicit-tls"), 993);
	assert.equal(defaultExternalAccountPort("imap", "starttls"), 143);
	assert.equal(defaultExternalAccountPort("imap", "none"), 143);
	assert.equal(defaultExternalAccountPort("pop3", "implicit-tls"), 995);
	assert.equal(defaultExternalAccountPort("pop3", "starttls"), 110);
	assert.equal(defaultExternalAccountPort("pop3", "none"), 110);

	assert.equal(truncateAccountError("short").length, 5);
	assert.equal(truncateAccountError("x".repeat(500)).length, 161);
	assert.equal(externalAccountLabel(accountView({})), "me@example.com@imap.example.com");
	assert.equal(formatSyncAge(new Date().toISOString(), "en", "just now"), "just now");
	assert.match(formatSyncAge(new Date(Date.now() - 5 * 60_000).toISOString(), "en", "just now"), /5 minutes ago|5 min/i);

	assert.deepEqual(validateExternalAccountDraft({ host: "imap.example.com", port: "993", username: "u", password: "p" }, { passwordRequired: true }), {});
	assert.deepEqual(
		validateExternalAccountDraft({ host: "bad host", port: "70000", username: " ", password: "" }, { passwordRequired: true }),
		{ host: true, port: true, username: true, password: true });
	assert.deepEqual(
		validateExternalAccountDraft({ host: "imap.example.com", port: "993", username: "u", password: "" }, { passwordRequired: false }),
		{}, "an empty password is fine when one is already stored");
});
