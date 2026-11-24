import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const stubs = {
	"@/components/language-provider": `export function useLanguage() { return { t: (key, vars) => vars ? key + " " + JSON.stringify(vars) : key }; }`,
	"@/components/ui/card": `
import React from "react";
export function Card(p) { return React.createElement("section", p, p.children); }
export function CardHeader(p) { return React.createElement("header", p, p.children); }
export function CardTitle(p) { return React.createElement("h2", p, p.children); }
export function CardDescription(p) { return React.createElement("p", p, p.children); }
export function CardContent(p) { return React.createElement("div", p, p.children); }`,
	"@/components/ui/skeleton": `
import React from "react";
export function Skeleton(p) { return React.createElement("div", { "data-skeleton": true, ...p }); }`,
	"@/components/icons": `
import React from "react";
const icon = (name) => function Icon(p) { return React.createElement("svg", { ...p, "data-icon": name }); };
export const FileText = icon("FileText");
export const HardDrive = icon("HardDrive");
export const Mail = icon("Mail");
export const Paperclip = icon("Paperclip");`,
	"@/lib/auth/client": `export async function authFetch(url) {
	globalThis.__fetchLog.push(url);
	return globalThis.__fetchResponse ?? { ok: true, async json() { return globalThis.__usageResponse; } };
}`,
};

const USAGE = {
	mailboxId: "m1",
	storageUsed: 37,
	breakdown: { bodyBytes: 22, attachmentBytes: 15, messageCount: 3 },
	computedAt: "2026-11-24T10:00:00.000Z",
};

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const { default: MailboxUsageCard } = await loadComponent(
	"src/components/mailboxes/mailbox-usage-card.tsx",
	stubs,
);
const utils = await loadComponent(
	"src/components/mailboxes/mailbox-usage-card-utils.ts",
	{ "@/lib/auth/client": stubs["@/lib/auth/client"] },
);

async function mount(t, element) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(element); });
	// The stubbed fetch resolves over a few event-loop turns (authFetch -> json ->
	// react-query scheduling); flush a fixed number so the rendered data settles.
	for (let i = 0; i < 5; i++) {
		await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	}
	return container;
}

function mountCard(t, props) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return mount(t, createElement(QueryClientProvider, { client },
		createElement(MailboxUsageCard, props)));
}

function stubUsage(response) {
	globalThis.__fetchLog = [];
	globalThis.__fetchResponse = undefined;
	globalThis.__usageResponse = response;
}

test("usage query key nests under the mailbox detail key", () => {
	assert.deepEqual(utils.mailboxUsageQueryKey("m1"), ["mailbox", "m1", "usage"]);
});

test("canViewMailboxUsage mirrors the endpoint's manage gate", () => {
	assert.equal(utils.canViewMailboxUsage("full_access"), true, "owners and full-access delegates");
	assert.equal(utils.canViewMailboxUsage(null), true, "admin managing the owner's account arrives as null");
	assert.equal(utils.canViewMailboxUsage("read_only"), false);
	assert.equal(utils.canViewMailboxUsage("send_as"), false);
	assert.equal(utils.canViewMailboxUsage("send_on_behalf"), false);
	assert.equal(utils.canViewMailboxUsage(undefined), false, "unknown permission never fires");
});

for (const permission of ["read_only", "send_as", "send_on_behalf", undefined]) {
	test(`no usage request fires for a ${permission ?? "missing"} mount`, async (t) => {
		stubUsage(USAGE);
		const container = await mountCard(t, { mailboxId: "m1", permission });
		assert.equal(globalThis.__fetchLog.length, 0, "a doomed GET must never fire");
		assert.equal(container.innerHTML, "", "read-only viewers see nothing");
	});
}

test("a full_access mount fetches usage and renders the breakdown", async (t) => {
	stubUsage(USAGE);
	const container = await mountCard(t, { mailboxId: "m1", permission: "full_access" });
	assert.deepEqual(globalThis.__fetchLog, ["/api/mailboxes/m1/usage"]);
	const text = container.textContent;
	assert.ok(text.includes("mailbox.usage"), "card title renders");
	assert.ok(text.includes("37 B"), "formatted storage used renders");
	assert.ok(text.includes("mailbox.usageMessages") && text.includes("3"), "message count renders");
	assert.ok(text.includes("22 B"), "body bytes render");
	assert.ok(text.includes("15 B"), "attachment bytes render");
	assert.ok(text.includes("mailbox.usageComputedAt"), "computedAt line renders");
});

test("an admin manage-path mount (permission null) fetches usage", async (t) => {
	stubUsage(USAGE);
	await mountCard(t, { mailboxId: "m1", permission: null });
	assert.deepEqual(globalThis.__fetchLog, ["/api/mailboxes/m1/usage"]);
});

test("an empty mailbox shows the neutral state instead of zeroed rows", async (t) => {
	stubUsage({
		...USAGE,
		storageUsed: 0,
		breakdown: { bodyBytes: 0, attachmentBytes: 0, messageCount: 0 },
	});
	const container = await mountCard(t, { mailboxId: "m1", permission: "full_access" });
	assert.ok(container.textContent.includes("mailbox.usageEmpty"), "empty copy renders");
	assert.ok(!container.textContent.includes("mailbox.usageTotal"), "no zeroed total row");
});

test("a failed usage request shows the error state", async (t) => {
	stubUsage(USAGE);
	globalThis.__fetchResponse = { ok: false, async json() { return { error: "Mailbox not found" }; } };
	const container = await mountCard(t, { mailboxId: "m1", permission: "full_access" });
	assert.ok(container.textContent.includes("Mailbox not found"), "the server error surfaces");
});
