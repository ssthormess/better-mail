import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

// The real section and the real utils; only the network is stubbed. The language context's default
// translator is real English, so the assertions check the copy users actually read.
const stubs = {
	"@/lib/auth/client": `export function authFetch(...args) { return globalThis.__folderRetentionFetch(...args); }`,
};

const { FolderRetentionSection } = await loadComponent("src/components/folder-retention-section.tsx", stubs);
const utils = await loadComponent("src/components/folder-retention-utils.ts", stubs);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const requests = [];
const drafts = [];
let respond = () => response({ folderId: "fld_1", days: null });

globalThis.__folderRetentionFetch = async (url, options = {}) => {
	const request = { url, method: options.method || "GET", payload: options.body ? JSON.parse(options.body) : null };
	requests.push(request);
	return respond(url, request);
};

beforeEach(() => {
	requests.length = 0;
	drafts.length = 0;
	respond = () => response({ folderId: "fld_1", days: null });
});

function response(data, status = 200) {
	return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

async function renderSection(t, { canManage = true, result } = {}) {
	if (result) respond = () => result;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	t.after(async () => {
		await act(async () => reactRoot.unmount());
		container.remove();
	});
	await act(async () => {
		reactRoot.render(createElement(FolderRetentionSection, {
			folderId: "fld_1",
			canManage,
			onChange: (draft) => drafts.push(draft),
		}));
	});
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
	return container;
}

async function click(element) {
	await act(async () => {
		element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

async function type(input, value) {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

test("a folder with no rule shows the inherit state and what falls back", async (t) => {
	const container = await renderSection(t, { result: response({ folderId: "fld_1", days: null }) });
	const toggle = container.querySelector('[role="switch"]');
	assert.equal(toggle.getAttribute("aria-checked"), "false");
	assert.equal(container.querySelector('input[type="number"]'), null, "no days input while inheriting");
	assert.match(container.textContent, /Mail in this folder is kept/, "says what happens without a rule");
	assert.deepEqual(drafts.at(-1), { days: null, baseline: null, valid: true });
	assert.deepEqual(requests, [{ url: "/api/folders/fld_1/retention", method: "GET", payload: null }]);
});

test("a set rule shows its days and reports edits inside the API's 1-365 bounds", async (t) => {
	const container = await renderSection(t, { result: response({ folderId: "fld_1", days: 30 }) });
	assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "true");
	const input = container.querySelector('input[type="number"]');
	assert.equal(input.value, "30");
	assert.equal(input.min, "1");
	assert.equal(input.max, "365");
	assert.match(container.textContent, /Date header/, "the copy says age counts from the message's own date");

	await type(input, "400");
	assert.equal(drafts.at(-1).valid, false, "out of range is not saveable");
	assert.equal(drafts.at(-1).days, 30, "an invalid draft keeps the baseline so it cannot wipe the rule");
	assert.match(container.textContent, /between 1 and 365/);

	await type(input, "14");
	assert.deepEqual(drafts.at(-1), { days: 14, baseline: 30, valid: true });
});

test("switching the rule off drafts a clear back to the account fallback", async (t) => {
	const container = await renderSection(t, { result: response({ folderId: "fld_1", days: 30 }) });
	await click(container.querySelector('[role="switch"]'));
	assert.deepEqual(drafts.at(-1), { days: null, baseline: 30, valid: true });
	assert.equal(utils.folderRetentionIsDirty(drafts.at(-1)), true);
	assert.match(container.textContent, /Mail in this folder is kept/, "cleared state explains the fallback");
});

test("read-only delegates see the effective state but cannot change it", async (t) => {
	const container = await renderSection(t, { canManage: false, result: response({ folderId: "fld_1", days: 30 }) });
	const toggle = container.querySelector('[role="switch"]');
	assert.equal(toggle.disabled, true);
	assert.equal(container.querySelector('input[type="number"]').disabled, true);
	assert.match(container.textContent, /full access/);
	await click(toggle);
	assert.equal(toggle.getAttribute("aria-checked"), "true", "the disabled switch does not flip");
	assert.equal(drafts.length, 1, "only the load draft was reported");
});

test("a failed load surfaces an error instead of the controls", async (t) => {
	const container = await renderSection(t, { result: response({ error: "Folder not found" }, 404) });
	assert.equal(container.querySelector('[role="switch"]'), null);
	assert.match(container.textContent, /Could not load retention settings/);
});

test("the days input parses like the API: whole numbers in 1-365", () => {
	for (const [raw, days] of [["1", 1], ["30", 30], ["365", 365], [" 60 ", 60]]) {
		assert.equal(utils.parseFolderRetentionDays(raw), days, raw);
	}
	for (const raw of ["", " ", "0", "366", "-5", "1.5", "abc", "30a"]) {
		assert.equal(utils.parseFolderRetentionDays(raw), null, raw);
	}
});

test("only the manage right may change retention", () => {
	assert.equal(utils.canEditFolderRetention("full_access"), true);
	for (const permission of ["read_only", "send_as", "send_on_behalf", undefined]) {
		assert.equal(utils.canEditFolderRetention(permission), false, permission);
	}
});

test("a draft is a write only when valid and different from the baseline", () => {
	assert.equal(utils.folderRetentionIsDirty({ days: 14, baseline: 30, valid: true }), true);
	assert.equal(utils.folderRetentionIsDirty({ days: null, baseline: 30, valid: true }), true);
	assert.equal(utils.folderRetentionIsDirty({ days: 30, baseline: 30, valid: true }), false);
	assert.equal(utils.folderRetentionIsDirty({ days: null, baseline: null, valid: true }), false);
	assert.equal(utils.folderRetentionIsDirty({ days: 30, baseline: 30, valid: false }), false);
	assert.equal(utils.folderRetentionIsDirty(null), false);
});

test("the draft keeps the baseline while the input is invalid", () => {
	assert.deepEqual(utils.folderRetentionDraft(true, "400", 30), { days: 30, baseline: 30, valid: false });
	assert.deepEqual(utils.folderRetentionDraft(true, "", null), { days: null, baseline: null, valid: false });
	assert.deepEqual(utils.folderRetentionDraft(true, "14", 30), { days: 14, baseline: 30, valid: true });
	assert.deepEqual(utils.folderRetentionDraft(false, "garbage", 30), { days: null, baseline: 30, valid: true });
});

test("the save writes only a changed, valid draft the mailbox may manage", async () => {
	for (const [draft, permission] of [
		[{ days: 14, baseline: 30, valid: true }, "read_only"],
		[{ days: 30, baseline: 30, valid: true }, "full_access"],
		[{ days: 30, baseline: 30, valid: false }, "full_access"],
		[null, "full_access"],
	]) {
		assert.equal(await utils.saveFolderRetentionDraft("fld_1", draft, permission), false);
	}
	assert.deepEqual(requests, [], "no PATCH went out");

	respond = () => response({ folderId: "fld_1", days: null });
	assert.equal(await utils.saveFolderRetentionDraft("fld_1", { days: null, baseline: 30, valid: true }, "full_access"), true);
	assert.deepEqual(requests, [{ url: "/api/folders/fld_1/retention", method: "PATCH", payload: { days: null } }]);
});

test("a failed save surfaces the API error for the dialog to show", async () => {
	respond = () => response({ error: "Folder not found" }, 404);
	await assert.rejects(
		() => utils.saveFolderRetentionDraft("fld_1", { days: 14, baseline: 30, valid: true }, "full_access"),
		/Folder not found/,
	);
});
