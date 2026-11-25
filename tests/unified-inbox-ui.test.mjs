import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act } from "react";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-unified-inbox-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			import { MessageRowMailboxBadge } from "./src/components/messages/message-row-mailbox-badge.tsx";
			export * from "./src/components/mailbox-selection.ts";
			export { getRowMailboxLabel, getMailboxAddress } from "./src/components/messages/utils.ts";
			export { MessageRowMailboxBadge };
			export function renderBadge(mailbox) {
				return renderToStaticMarkup(createElement(MessageRowMailboxBadge, { mailbox }));
			}
		`,
		resolveDir: root,
		sourcefile: "unified-inbox-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const {
	SELECTED_MAILBOX_ALL_VALUE,
	parseStoredMailboxSelection,
	resolveMailboxSelection,
	serializeMailboxSelection,
	getRowMailboxLabel,
	getMailboxAddress,
	renderBadge,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const mailbox = (id, overrides = {}) => ({
	id,
	domainId: "domain",
	localPart: id,
	hostname: "example.com",
	displayName: null,
	...overrides,
});
const primary = mailbox("primary", { displayName: "Maya Chen", isPrimary: true });
const shared = mailbox("shared", { displayName: "Support", type: "shared" });

test("the all-mailboxes sentinel can never be a mailbox id", () => {
	// Mailbox ids are nanoids: letters, digits, `_` and `-`. The sentinel uses a character outside that alphabet.
	assert.doesNotMatch(SELECTED_MAILBOX_ALL_VALUE, /^[A-Za-z0-9_-]+$/);
	assert.equal(parseStoredMailboxSelection(SELECTED_MAILBOX_ALL_VALUE).kind, "all");
	assert.deepEqual(parseStoredMailboxSelection("V1StGXR8_Z5jdHi6B-myT"), { kind: "mailbox", id: "V1StGXR8_Z5jdHi6B-myT" });
});

test("an empty or missing key is an unset preference, not a mailbox", () => {
	for (const value of [null, undefined, ""]) assert.deepEqual(parseStoredMailboxSelection(value), { kind: "unset" });
});

test("the selection round-trips through storage", () => {
	assert.equal(serializeMailboxSelection("primary"), "primary");
	assert.equal(serializeMailboxSelection(null), SELECTED_MAILBOX_ALL_VALUE);
	assert.deepEqual(parseStoredMailboxSelection(serializeMailboxSelection(null)), { kind: "all" });
	assert.deepEqual(parseStoredMailboxSelection(serializeMailboxSelection("primary")), { kind: "mailbox", id: "primary" });
});

test("a stored mailbox selection resolves to that mailbox and is left alone", () => {
	const resolved = resolveMailboxSelection([primary, shared], { kind: "mailbox", id: "shared" });
	assert.equal(resolved.mailbox?.id, "shared");
	assert.equal(resolved.storageValue, null);
});

test("all mailboxes survives a reload when there is more than one", () => {
	const resolved = resolveMailboxSelection([primary, shared], { kind: "all" });
	assert.equal(resolved.mailbox, null);
	assert.equal(resolved.storageValue, SELECTED_MAILBOX_ALL_VALUE);
});

test("all mailboxes falls back to the primary when only one mailbox is accessible", () => {
	const resolved = resolveMailboxSelection([primary], { kind: "all" });
	assert.equal(resolved.mailbox?.id, "primary");
	assert.equal(resolved.storageValue, "primary");
});

test("no stored preference starts on the primary, and so does a stale id", () => {
	for (const stored of [{ kind: "unset" }, { kind: "mailbox", id: "deleted" }]) {
		const resolved = resolveMailboxSelection([shared, primary], stored);
		assert.equal(resolved.mailbox?.id, "primary");
		assert.equal(resolved.storageValue, "primary");
	}
	// Without a primary, the first accessible mailbox is the fallback.
	assert.equal(resolveMailboxSelection([shared], { kind: "unset" }).mailbox?.id, "shared");
});

test("an empty account keeps its stored preference instead of writing a fallback", () => {
	for (const stored of [{ kind: "unset" }, { kind: "mailbox", id: "primary" }, { kind: "all" }]) {
		assert.deepEqual(resolveMailboxSelection([], stored), { mailbox: null, storageValue: null });
	}
	assert.equal(resolveMailboxSelection([], { kind: "all" }).storageValue, null);
});

test("a unified row badge labels its mailbox by display name, then local part", () => {
	assert.equal(getRowMailboxLabel(shared), "Support");
	assert.equal(getRowMailboxLabel(mailbox("billing")), "billing");
	assert.equal(getRowMailboxLabel(null), null);
	assert.equal(getRowMailboxLabel(undefined), null);
	assert.equal(getMailboxAddress(shared), "shared@example.com");
	assert.equal(getMailboxAddress(null), null);
});

// --- The selector's "All mailboxes" entry, rendered in jsdom -------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "https://mail.example/inbox",
	pretendToBeVisual: true,
});
after(() => dom.window.close());
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "MutationObserver", "HTMLInputElement", "localStorage", "Storage"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const stubs = new Map([
	["next/link", `
import React from "react";
export default function Link({ href, children, ...props }) {
  return React.createElement("a", { href, ...props }, children);
}
`],
	["next/navigation", `
export function usePathname() { return "/inbox"; }
export function useRouter() {
  return { push(href) { (globalThis.__selectorPushes ??= []).push(href); }, replace() {}, refresh() {}, prefetch() {} };
}
`],
	["@/components/mailbox-provider", `
export function useSelectedMailbox() { return globalThis.__selectorMailboxes; }
`],
	["@/components/language-provider", `
export function useLanguage() {
  return { t(key, vars) { return vars && vars.count !== undefined ? key + ":" + vars.count : key; } };
}
`],
	["@/components/apps-menu", `export function AppsMenu() { return null; }`],
	["@/components/progressive-avatar-image", `export function ProgressiveAvatarImage() { return null; }`],
	["@/components/ui/tooltip", `export function Tooltip({ children }) { return children; }`],
	["@/components/ui/skeleton", `export function Skeleton() { return null; }`],
	["@/components/ui/confirm-dialog", `
export async function alertDialog() {}
export async function confirmDestructive() { return true; }
`],
	["@/hooks/use-message-counts", `
export function useMessageCounts() { return { counts: { mailboxes: [], folders: {}, customFolders: {}, promotionModes: {} }, isLoading: false }; }
`],
	["@/hooks/use-current-user", `
export async function fetchCurrentUser() { return null; }
export function clearCurrentUserCache() {}
`],
	["@/lib/auth/client", `
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:test-auth-changed";
export function getClientSessionToken() { return null; }
export async function authFetch() { return { ok: true, async json() { return {}; } }; }
`],
	["@/lib/auth/logout", `export async function logoutClientSession() { return false; }`],
	["@/lib/auth/accounts-client", `
export async function fetchBrowserAccounts() { return []; }
export async function switchBrowserAccount() { return null; }
export async function signOutBrowserAccount() { return null; }
`],
	["@/lib/profile/avatar-client", `
export const PROFILE_AVATAR_CHANGED_EVENT = "mailflare:test-profile-avatar";
export function getProfileAvatarUrl() { return "/api/profile/avatar"; }
`],
	["@/lib/profile/name-client", `export const PROFILE_NAME_CHANGED_EVENT = "mailflare:test-profile-name";`],
	["@/lib/mailboxes/avatar-client", `export const MAILBOX_AVATAR_CHANGED_EVENT = "mailflare:test-mailbox-avatar";`],
]);

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { createRoot } from "react-dom/client";
			import { act } from "react";
			import { MailboxSelector } from "@/components/mailbox-selector";
			import { useActiveMailbox } from "@/components/use-active-mailbox";
			export { act };
			const user = { id: "user-1", email: "maya@example.com", name: "Maya Chen", role: "user", hasAvatar: false, calendarEnabled: false, driveEnabled: false };
			export async function mountSelector(state) {
				globalThis.__selectorMailboxes = state;
				globalThis.__selectorPushes = [];
				document.body.replaceChildren();
				const container = document.createElement("div");
				document.body.appendChild(container);
				const reactRoot = createRoot(container);
				await act(async () => { reactRoot.render(createElement(MailboxSelector, { initialUser: user })); });
				return { container, async unmount() { await act(async () => reactRoot.unmount()); } };
			}
			// What per-mailbox screens (compose, the assistant, settings) send as their mailbox.
			function ActiveMailboxProbe() {
				const mailbox = useActiveMailbox();
				return createElement("span", { "data-active-mailbox": mailbox?.id ?? "none" });
			}
			export async function activeMailboxFor(state) {
				globalThis.__selectorMailboxes = state;
				document.body.replaceChildren();
				const container = document.createElement("div");
				document.body.appendChild(container);
				const reactRoot = createRoot(container);
				await act(async () => { reactRoot.render(createElement(ActiveMailboxProbe)); });
				const id = container.querySelector("[data-active-mailbox]").getAttribute("data-active-mailbox");
				await act(async () => reactRoot.unmount());
				container.remove();
				return id;
			}
		`,
		resolveDir: root,
		loader: "tsx",
		sourcefile: "unified-selector-entry.tsx",
	},
	outfile: join(directory, "selector.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	tsconfig: join(root, "tsconfig.json"),
	external: ["react", "react-dom", "react-dom/client", "jsdom"],
	alias: { "@": join(root, "src") },
	logLevel: "silent",
	loader: { ".js": "jsx" },
	plugins: [{
		name: "unified-inbox-test-stubs",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => (stubs.has(args.path) ? { path: args.path, namespace: "test-stub" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => ({ contents: stubs.get(args.path), loader: "jsx", resolveDir: root }));
			builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
		},
	}],
});

const selector = await import(pathToFileURL(join(directory, "selector.mjs")).href);

const unifiedMailboxes = [
	mailbox("primary", { displayName: "Maya Chen", isPrimary: true, domainId: "domain" }),
	mailbox("shared", { displayName: "Support", type: "shared", domainId: "domain" }),
];

function selectorState({ mailboxes, selectedMailbox }) {
	const selections = [];
	return {
		selections,
		state: {
			mailboxes,
			selectedMailbox,
			isLoading: false,
			setSelectedMailbox(next) { selections.push(next ? next.id : next); },
		},
	};
}

const buttonByLabel = (container, label) => container.querySelector(`button[aria-label="${label}"]`);

async function openMenu(app) {
	await act(async () => { buttonByLabel(app.container, "account.openMenu").click(); });
}

async function mountSelector(t, { mailboxes, selectedMailbox }) {
	const { state, selections } = selectorState({ mailboxes, selectedMailbox });
	const app = await selector.mountSelector(state);
	t.after(async () => { await app.unmount(); document.body.replaceChildren(); });
	return { ...app, selections };
}

test("the account menu offers All mailboxes and selects it", async (t) => {
	const app = await mountSelector(t, { mailboxes: unifiedMailboxes, selectedMailbox: unifiedMailboxes[0] });
	await openMenu(app);

	const entry = [...app.container.querySelectorAll("button")]
		.find((button) => button.textContent.includes("account.allMailboxes"));
	assert.ok(entry, "the menu lists an All mailboxes entry");
	assert.match(entry.textContent, /account\.inboxes:2/, "it says how many mailboxes it merges");

	await act(async () => { entry.click(); });
	assert.deepEqual(app.selections, [null], "selecting it clears the mailbox selection");
	assert.deepEqual(globalThis.__selectorPushes, ["/inbox"], "and lands on the merged inbox");
});

test("the entry is hidden with a single mailbox, which has nothing to merge", async (t) => {
	const app = await mountSelector(t, { mailboxes: [unifiedMailboxes[0]], selectedMailbox: unifiedMailboxes[0] });
	await openMenu(app);
	assert.equal(
		[...app.container.querySelectorAll("button")].some((button) => button.textContent.includes("account.allMailboxes")),
		false,
	);
});

test("unified mode shows All mailboxes as the current selection", async (t) => {
	const app = await mountSelector(t, { mailboxes: unifiedMailboxes, selectedMailbox: null });
	await openMenu(app);

	assert.match(app.container.textContent, /account\.allMailboxes/);
	// The selected card stands in for the entry, so the menu does not offer All mailboxes twice.
	assert.equal(
		[...app.container.querySelectorAll("button")].filter((button) => button.textContent.includes("account.allMailboxes")).length,
		0,
	);
});

test("per-mailbox screens resolve the primary while the list shows every mailbox", async () => {
	// This is the mailbox compose, the assistant and the settings forms act on.
	const withAll = (selectedMailbox) => selectorState({ mailboxes: unifiedMailboxes, selectedMailbox }).state;
	assert.equal(await selector.activeMailboxFor(withAll(null)), "primary", "unified mode falls back to the primary");
	assert.equal(await selector.activeMailboxFor(withAll(unifiedMailboxes[1])), "shared", "a real selection wins");
	assert.equal(
		await selector.activeMailboxFor(selectorState({ mailboxes: [unifiedMailboxes[1], mailbox("billing")], selectedMailbox: null }).state),
		"shared",
		"without a primary, the first accessible mailbox is the fallback",
	);
	assert.equal(await selector.activeMailboxFor(selectorState({ mailboxes: [], selectedMailbox: null }).state), "none");
});

test("the row badge draws nothing without a mailbox and a name with one", () => {
	assert.equal(renderBadge(null), "");
	assert.equal(renderBadge(undefined), "");
	const markup = renderBadge(shared);
	assert.match(markup, />Support</);
	assert.match(markup, /title="shared@example\.com"/);
	assert.match(markup, /ms-2/);
	assert.equal(renderBadge(mailbox("billing")), '<span title="billing@example.com" class="ms-2 inline-flex max-w-36 shrink-0 items-center truncate rounded-md bg-neutral-100 px-1.5 text-[11px] font-medium leading-5 text-neutral-600 ring-1 ring-inset ring-neutral-200">billing</span>');
});
