/**
 * Where the app is running. On Cloudflare Workers the bindings come from
 * cloudflare:workers; the self-hosted Node server builds an equivalent env object and
 * publishes it on globalThis before Next starts, so route handlers reach it
 * the same way.
 */
declare global {
	var __mailflareNodeEnv: CloudflareEnv | undefined;
}

export function getNodeEnv(): CloudflareEnv | undefined {
	return globalThis.__mailflareNodeEnv;
}

export function isNodeRuntime(env?: Pick<CloudflareEnv, "MAILFLARE_RUNTIME">): boolean {
	return (env ?? getNodeEnv())?.MAILFLARE_RUNTIME === "node";
}

/**
 * True only when the deployment positively asserts its fetch egress is public-internet-only —
 * hosted Cloudflare Workers, where the platform refuses non-public destinations and the worker
 * config also sets the global_fetch_strictly_public compat flag. MAILFLARE_RUNTIME=cloudflare is
 * that assertion, declared in wrangler vars; a self-hosted workerd can allow private egress and
 * must not set it, so anything but the explicit value reads false — callers must fail closed.
 */
export function hasPublicEgressGuarantee(env?: Pick<CloudflareEnv, "MAILFLARE_RUNTIME">): boolean {
	return (env ?? getNodeEnv())?.MAILFLARE_RUNTIME === "cloudflare";
}

/** True when the app can talk to the Cloudflare API to manage zones and routing. */
export function hasCloudflareCredentials(env: Pick<CloudflareEnv, "CF_TOKEN" | "CF_API_KEY" | "CF_EMAIL">): boolean {
	return !!env.CF_TOKEN?.trim() || (!!env.CF_API_KEY?.trim() && !!env.CF_EMAIL?.trim());
}
