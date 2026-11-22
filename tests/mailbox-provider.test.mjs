import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, beforeEach } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// The form tests stub the mailbox provider, so nothing exercised the real
// same-id replacement path. This file mounts the real MailboxProvider with the
// real form and the real fetchMailboxOptions; only the network, translations
// and plain UI pieces are stubbed.

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-provider-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement", "HTMLTextAreaElement"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The datetime-local fields convert through the saved user timezone; pin UTC so
// the expected ISO strings do not depend on the machine the test runs on.
dom.window.localStorage.setItem("mailflare-user-time-zone", JSON.stringify({ timeZone: "UTC" }));

const mock = new Map([
  ["@/components/language-provider", `export function useLanguage() { return { t(key) { return key; } }; }`],
  ["@/lib/auth/client", `
    export const AUTH_SESSION_CHANGED_EVENT = "mailflare-auth-session-changed";
    export function getClientSessionToken() { return "test-session"; }
    export function authFetch(...args) { return globalThis.__providerTestFetch(...args); }
  `],
  ["@/lib/profile/name-client", `export const PROFILE_NAME_CHANGED_EVENT = "mailflare-profile-name-changed";`],
  ["@/lib/profile/avatar-client", `export const PROFILE_AVATAR_CHANGED_EVENT = "mailflare-profile-avatar-changed";`],
  ["@/lib/http/client-error", `export function requestError(message) { return new Error(message); }`],
]);

const genericUI = `
import React from "react";
export function Button({children, size, variant, pill, ...props}) {return React.createElement("button",props,children);}
export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});
export const Textarea = React.forwardRef(function Textarea(props,ref){return React.createElement("textarea",{...props,ref});});
export function Label({children,...props}){return React.createElement("label",props,children);}
export function Checkbox(props){return React.createElement("input",{type:"checkbox",...props});}
`;

// One module graph so the provider and the form share the real MailboxContext.
await build({
  stdin: {
    contents: `
      export { MailboxProvider, useSelectedMailbox } from "./mailbox-provider";
      export { clearMailboxesCache } from "./mailbox-provider-utils";
      export { MailboxAutoReplyForm } from "./settings/mailbox-auto-reply-form";
    `,
    sourcefile: "provider-test-entry.ts",
    resolveDir: join(root, "src/components"),
    loader: "ts",
  },
  outfile: join(temp, "bundle.mjs"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  packages: "external",
  external: ["react", "react-dom", "react-dom/*"],
  alias: { "@": join(root, "src") },
  plugins: [{
    name: "provider-test-stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (mock.has(args.path)) return { path: args.path, namespace: "provider-test-stub" };
        if (/^@\/components\/ui\//.test(args.path)) return { path: args.path, namespace: "provider-ui-stub" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "provider-test-stub" }, args => ({ contents: mock.get(args.path), loader: "tsx" }));
      b.onLoad({ filter: /.*/, namespace: "provider-ui-stub" }, () => ({ contents: genericUI, loader: "tsx" }));
    },
  }],
  logLevel: "silent",
});
const { createElement, act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MailboxProvider, useSelectedMailbox, clearMailboxesCache, MailboxAutoReplyForm } =
  await import(pathToFileURL(join(temp, "bundle.mjs")).href);

// The server side of the API: GET lists the stored row, PATCH applies the
// payload onto it and returns the full updated row like the real route.
const requests = [];
let serverMailbox = null;
globalThis.__providerTestFetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const payload = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, method, payload });
  if (url === "/api/mailboxes" && method === "GET") {
    return response({ mailboxes: [serverMailbox] });
  }
  if (url === "/api/mailboxes/mailbox-1" && method === "PATCH") {
    serverMailbox = { ...serverMailbox, ...payload };
    return response({ mailbox: serverMailbox });
  }
  return response({ error: "Unexpected route" }, 500);
};
beforeEach(() => {
  requests.length = 0;
  serverMailbox = null;
  clearMailboxesCache();
  dom.window.localStorage.removeItem("selected-mailbox-id");
});

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

// A probe inside the provider hands the real context value back after each commit.
let providerValue = null;
function Probe() {
  const ctx = useSelectedMailbox();
  useEffect(() => { providerValue = ctx; });
  return null;
}

async function renderProvider(t) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  t.after(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
  });
  await act(async () => {
    reactRoot.render(createElement(
      MailboxProvider, null,
      createElement(Probe),
      createElement(MailboxAutoReplyForm),
    ));
  });
  // loadMailboxes resolves async; flush until the mailbox lands and the form renders.
  for (let i = 0; i < 50 && !providerValue?.selectedMailbox; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.ok(providerValue?.selectedMailbox, "the provider loaded the mailbox");
  return { container };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10)); // let the save request finish
  });
}

async function type(element, value) {
  await act(async () => {
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("a same-id save lands in the real provider across two saves", async t => {
  serverMailbox = {
    id: "mailbox-1", domainId: "domain-1", localPart: "tester", hostname: "example.com",
    displayName: "Tester", signature: null, autoReplyEnabled: true,
    autoReplySubject: "Out of office", autoReplyBody: "Back on Monday.",
    autoReplyStartAt: "2026-07-01T09:00:00.000Z", autoReplyEndAt: "2026-07-10T17:00:00.000Z",
    hasAvatar: false, type: "personal", permission: "full_access", isPrimary: true,
    senderAddresses: ["tester@example.com"],
  };
  const { container } = await renderProvider(t);
  const loaded = providerValue.selectedMailbox;
  assert.equal(loaded.autoReplyStartAt, "2026-07-01T09:00:00.000Z");
  assert.equal(container.querySelector("#autoReplyStartAt").value, "2026-07-01T09:00");

  // Save 1 changes only the start. The form hands the provider a fresh same-id
  // object, and it must land, not be dropped as a same-id no-op.
  await type(container.querySelector("#autoReplyStartAt"), "2026-07-05T09:00");
  await click(container.querySelector('button[type="submit"]'));
  assert.equal(requests[1].payload.autoReplyStartAt, "2026-07-05T09:00:00.000Z");
  assert.equal("autoReplyEndAt" in requests[1].payload, false, "the untouched end is not sent");
  const afterFirst = providerValue.selectedMailbox;
  assert.notEqual(afterFirst, loaded, "the replacement object landed in provider state");
  assert.equal(afterFirst.autoReplyStartAt, "2026-07-05T09:00:00.000Z", "provider reflects the response");
  assert.equal(afterFirst.autoReplyEndAt, "2026-07-10T17:00:00.000Z", "the untouched end is carried forward");
  assert.equal(providerValue.mailboxes[0].autoReplyStartAt, "2026-07-05T09:00:00.000Z", "the list entry updates too");

  // Save 2 changes only the message. Both bounds stay out of the request and
  // fall back to provider state, so the start from save 1 must survive and the
  // stored end must not be blanked or reverted.
  await type(container.querySelector("#autoReplyBody"), "Still away.");
  await click(container.querySelector('button[type="submit"]'));
  assert.equal("autoReplyStartAt" in requests[2].payload, false, "the start is not re-sent");
  assert.equal("autoReplyEndAt" in requests[2].payload, false, "the end is not re-sent");
  assert.equal(providerValue.selectedMailbox.autoReplyStartAt, "2026-07-05T09:00:00.000Z", "the saved start is not reverted");
  assert.equal(providerValue.selectedMailbox.autoReplyEndAt, "2026-07-10T17:00:00.000Z", "the stored end is not blanked");
  assert.equal(providerValue.selectedMailbox.autoReplyBody, "Still away.");
  assert.equal(container.querySelector("#autoReplyStartAt").value, "2026-07-05T09:00", "the start control still shows it");
  assert.equal(container.querySelector("#autoReplyEndAt").value, "2026-07-10T17:00", "the end control still shows it");
});
