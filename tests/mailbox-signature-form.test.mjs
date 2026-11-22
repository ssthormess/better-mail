import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, beforeEach } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Saving a signature lands back in the mailbox provider; that provider update
// must not erase the "saved" status the form just set.

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-signature-form-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement", "HTMLTextAreaElement"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = new Map([
  ["@/components/language-provider", `export function useLanguage() { return { t(key) { return key; } }; }`],
  ["@/components/mailbox-provider", `export function useSelectedMailbox() { return globalThis.__signatureTestMailbox; }`],
  ["@/components/mailbox-provider-utils", `export function clearMailboxesCache() {}`],
  ["@/components/compose/rich-text-utils", `export function isHtmlSignature() { return false; }`],
  ["@/components/messages/email-html-renderer", `export function EmailHtmlRenderer() { return null; }`],
  ["@/lib/auth/client", `export function authFetch(...args) { return globalThis.__signatureTestFetch(...args); }`],
  ["@/lib/http/client-error", `export function requestError(message) { return new Error(message); }`],
]);

const genericUI = `
import React from "react";
export function Button({children, size, variant, pill, ...props}) {return React.createElement("button",props,children);}
export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});
export const Textarea = React.forwardRef(function Textarea(props,ref){return React.createElement("textarea",{...props,ref});});
export function Label({children,...props}){return React.createElement("label",props,children);}
`;

// The real form and the real settings/utils.ts save call; only the network,
// translations, mailbox provider and plain UI pieces are stubbed.
await build({
  stdin: {
    contents: readFileSync(join(root, "src/components/settings/mailbox-signature-form.tsx"), "utf8"),
    sourcefile: "mailbox-signature-form.tsx",
    resolveDir: join(root, "src/components/settings"),
    loader: "tsx",
  },
  outfile: join(temp, "form.mjs"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  packages: "external",
  external: ["react", "react-dom", "react-dom/*"],
  alias: { "@": join(root, "src") },
  plugins: [{
    name: "signature-test-stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (mock.has(args.path)) return { path: args.path, namespace: "signature-test-stub" };
        if (/^@\/components\/ui\//.test(args.path)) return { path: args.path, namespace: "signature-ui-stub" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "signature-test-stub" }, args => ({ contents: mock.get(args.path), loader: "tsx" }));
      b.onLoad({ filter: /.*/, namespace: "signature-ui-stub" }, () => ({ contents: genericUI, loader: "tsx" }));
    },
  }],
  logLevel: "silent",
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MailboxSignatureForm } = await import(pathToFileURL(join(temp, "form.mjs")).href);

const requests = [];
globalThis.__signatureTestFetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const payload = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, method, payload });
  if (url === "/api/mailboxes/mailbox-1" && method === "PATCH") {
    return response({ mailbox: { id: "mailbox-1", ...payload } });
  }
  return response({ error: "Unexpected route" }, 500);
};
beforeEach(() => { requests.length = 0; });

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

async function renderForm(t, mailbox) {
  const updates = [];
  // Like the real provider: setSelectedMailbox replaces the stored mailbox.
  globalThis.__signatureTestMailbox = {
    selectedMailbox: mailbox,
    setSelectedMailbox(next) { updates.push(next); globalThis.__signatureTestMailbox.selectedMailbox = next; },
    isLoading: false,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  t.after(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
  });
  await act(async () => { reactRoot.render(createElement(MailboxSignatureForm)); });
  return { container, updates };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

async function type(element, value) {
  await act(async () => {
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("a saved signature keeps its status after the provider update lands", async t => {
  const mailbox = {
    id: "mailbox-1", localPart: "tester", hostname: "example.com", permission: "full_access",
    signature: "Old signature",
  };
  const { container, updates } = await renderForm(t, mailbox);

  await type(container.querySelector("#mailboxSignature"), "New signature");
  await click(container.querySelector('button[type="submit"]'));
  assert.deepEqual(requests, [{
    url: "/api/mailboxes/mailbox-1",
    method: "PATCH",
    payload: { signature: "New signature" },
  }]);
  assert.equal(updates.at(-1)?.signature, "New signature", "the provider gets the saved signature");
  assert.match(container.textContent, /common\.saved/, "the saved message survives the provider resync");
  assert.equal(container.querySelector('button[type="submit"]').disabled, true, "nothing is left to save");
});
