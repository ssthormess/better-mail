import { queryDns } from "@/lib/dns-query";
import { isForbiddenHostname, isIpLiteral, isPublicAddress } from "@/lib/remote-images/fetch";

/** Feed URLs cap at 512: it is the longest a MySQL index can hold, so every dialect agrees. */
export const FEED_MAX_URL_LENGTH = 512;
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const FEED_MAX_REDIRECTS = 3;
export const FEED_TIMEOUT_MS = 15_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FeedFetchErrorCode =
	| "invalid_url"
	| "not_public"
	| "dns_error"
	| "timeout"
	| "too_large"
	| "empty_body"
	| "too_many_redirects"
	| "invalid_redirect"
	| "http_error"
	| "fetch_failed"
	| "pinning_unavailable";

export class FeedFetchError extends Error {
	readonly httpStatus: number | null;
	constructor(
		message: string,
		readonly code: FeedFetchErrorCode,
		httpStatus: number | null = null,
	) {
		super(message);
		this.name = "FeedFetchError";
		this.httpStatus = httpStatus;
	}
}

/**
 * How one hop's connection is bound to the checked outcome. `dispatcher` is undici's per-request
 * override on Node: the socket only ever reaches the validated addresses while Host/SNI stay on
 * the URL hostname. `platformEgress` instead records that the runtime itself guarantees
 * public-internet-only egress — hosted Cloudflare Workers — where no per-request socket pin
 * exists (see defaultPinConnection). A pin carrying neither is not a pin and fails closed.
 */
export type FeedConnectionPin = {
	dispatcher?: { close?: () => Promise<unknown> };
	platformEgress?: "cloudflare-workers";
};

export type FeedFetchOptions = {
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	/** Resolves a hostname to its A and AAAA addresses; every one must be public. Defaults to DNS-over-HTTPS. */
	resolveHost?: (hostname: string) => Promise<string[]>;
	/** Turns the validated addresses into a connection pin; defaults to the runtime's facility. */
	pinConnection?: (hostname: string, addresses: string[]) => Promise<FeedConnectionPin>;
	/**
	 * The deployment positively asserts its fetch egress is public-internet-only — on this repo
	 * that is MAILFLARE_RUNTIME=cloudflare, set by the hosted deployment's wrangler vars (which
	 * also enable the global_fetch_strictly_public compat flag). Workers-family runtimes have no
	 * socket pin and rely on this assertion; unset means it was not made and they fail closed.
	 */
	publicEgressAsserted?: boolean;
	/** Validators from the previous fetch; a 304 answer skips the body entirely. */
	etag?: string | null;
	lastModified?: string | null;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
};

export type FeedFetchResult =
	| { outcome: "not-modified"; status: 304 }
	| { outcome: "fetched"; status: number; body: string; etag: string | null; lastModified: string | null };

/**
 * Canonicalizes a subscription URL: webcal:// becomes https:// (the scheme only signals "subscribe
 * me" to calendar apps; the wire protocol is https). http stays http — some public feeds still do
 * not serve TLS — but a redirect off the origin may only upgrade, never downgrade to http.
 * Credentials, IP literals and internal hostnames are refused outright.
 */
export function normalizeFeedUrl(value: string): URL {
	if (!value) throw new FeedFetchError("Enter a calendar feed URL", "invalid_url");
	if (value.length > FEED_MAX_URL_LENGTH) throw new FeedFetchError(`Calendar feed URLs accept at most ${FEED_MAX_URL_LENGTH} characters`, "invalid_url");
	let candidate = value.trim();
	if (candidate.toLowerCase().startsWith("webcal://")) candidate = `https://${candidate.slice("webcal://".length)}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new FeedFetchError("Enter a valid calendar feed URL", "invalid_url");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new FeedFetchError("Calendar feed URLs must use http, https or webcal", "invalid_url");
	if (url.username || url.password) throw new FeedFetchError("Calendar feed URLs cannot carry credentials", "invalid_url");
	if (!url.hostname || isIpLiteral(url.hostname) || isForbiddenHostname(url.hostname)) throw new FeedFetchError("Calendar feed must point at a public host", "not_public");
	return url;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
	const [v4, v6] = await Promise.all([queryDns(hostname, "A"), queryDns(hostname, "AAAA")]);
	return [...v4, ...v6];
}

/**
 * A public-looking name can still resolve to a private address, so check what it resolves to.
 * Returns the validated addresses — the caller pins the connection to exactly these, so the
 * resolution the fetcher actually uses is the one this check approved (no TOCTOU gap).
 */
async function resolvePublicHost(resolve: (hostname: string) => Promise<string[]>, hostname: string): Promise<string[]> {
	let addresses: string[];
	try {
		addresses = await resolve(hostname);
	} catch {
		throw new FeedFetchError("Could not verify the feed host", "dns_error");
	}
	if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
		throw new FeedFetchError("Calendar feed must point at a public host", "not_public");
	}
	return addresses;
}

type UndiciAgent = new (options: { connect: { lookup: (hostname: string, options: unknown, callback: (error: Error | null, addresses: { address: string; family: number }[]) => void) => void } }) => { close(): Promise<void> };

/**
 * Binds the checked addresses to the connection itself — or proves the platform already does.
 *
 * Workers-family runtimes (navigator.userAgent "Cloudflare-Workers", set by workerd whether it is
 * hosted on Cloudflare or self-hosted) offer NO per-request socket pin: `cf.resolveOverride` only
 * honors hostnames proxied on the same Cloudflare zone and ignores IP literals or external names,
 * and `cloudflare:sockets` Socket.startTls({expectedServerHostname}) sends no SNI on the
 * production edge (cloudflare/workerd#6903, open), so the connect-to-IP-plus-TLS path cannot
 * work either. What carries the guarantee on hosted Workers instead is the platform: fetch() can
 * only reach the public internet — workerd refuses non-public destinations (workerd discussion
 * #1523), this deployment additionally sets the global_fetch_strictly_public compat flag — and
 * TLS certificate verification binds the socket to the URL hostname, so a hop re-resolving to a
 * different public address still can only complete against a peer holding a cert for that name.
 * The DoH validation above stays as defense-in-depth on top of those two platform guarantees.
 *
 * That platform backstop exists ONLY where the deployment asserts it: a self-hosted workerd can
 * be configured with private egress (ExternalServer bindings), in which case there is neither a
 * pin nor an egress filter. Unasserted Workers runtimes therefore fail closed — as does any
 * runtime with no pinning facility at all (e.g. a plain Bun/Deno fetch). On Node a per-request
 * undici Agent answers DNS lookups with the already-validated address list — the resolution the
 * fetcher actually uses is the one the check approved, no TOCTOU gap. The URL is never rewritten
 * to an IP literal anywhere.
 */
async function defaultPinConnection(_hostname: string, addresses: string[], publicEgressAsserted: boolean): Promise<FeedConnectionPin> {
	if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
		if (!publicEgressAsserted) throw new FeedFetchError("Connection pinning is unavailable on this runtime", "pinning_unavailable");
		return { platformEgress: "cloudflare-workers" };
	}
	let Agent: UndiciAgent;
	try {
		({ Agent } = (await import(/* @vite-ignore */ "undici")) as { Agent: UndiciAgent });
	} catch {
		throw new FeedFetchError("Connection pinning is unavailable on this runtime", "pinning_unavailable");
	}
	return {
		dispatcher: new Agent({
			connect: {
				lookup: (_lookupHostname, _options, callback) =>
					callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))),
			},
		}),
	};
}

async function readLimitedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new FeedFetchError("Calendar feed is too large", "too_large");
	}
	if (!response.body) {
		// A 204-class body is a feed with no events; anything else without a body is a broken answer.
		throw new FeedFetchError("Calendar feed returned an empty body", "empty_body");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new FeedFetchError("Calendar feed is too large", "too_large");
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		if (signal.aborted && !(error instanceof FeedFetchError)) throw new FeedFetchError("Calendar feed request timed out", "timeout");
		throw error;
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/**
 * GETs a webcal/https feed through the SSRF guard: the hostname must parse clean, resolve only to
 * public addresses, and each hop's connection is bound to the outcome of that check — pinned to
 * the validated addresses on Node, or riding the platform's public-only egress on asserted
 * hosted Workers — resolve, validate, pin, fetch, in that order, repeated on every redirect hop.
 * Redirects may only go to https and the body is capped while it streams. A runtime that can
 * neither pin a connection nor assert public-only egress fails closed rather than trusting a
 * second, uncontrolled resolution.
 * Sends If-None-Match/If-Modified-Since when validators are held; a 304 short-circuits the refresh.
 */
export async function fetchCalendarFeed(value: string, options: FeedFetchOptions = {}): Promise<FeedFetchResult> {
	const fetchImpl = options.fetch ?? fetch;
	const maxBytes = options.maxBytes ?? FEED_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? FEED_MAX_REDIRECTS;
	const resolveHost = options.resolveHost ?? defaultResolveHost;
	const pinConnection = options.pinConnection ?? ((hostname: string, addresses: string[]) => defaultPinConnection(hostname, addresses, options.publicEgressAsserted === true));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? FEED_TIMEOUT_MS);
	try {
		let current = normalizeFeedUrl(value);
		for (let redirects = 0; ; redirects += 1) {
			const addresses = await resolvePublicHost(resolveHost, current.hostname);
			const pin = await pinConnection(current.hostname, addresses);
			if (!pin.dispatcher && pin.platformEgress !== "cloudflare-workers") throw new FeedFetchError("Connection pinning is unavailable on this runtime", "pinning_unavailable");
			try {
				const headers: Record<string, string> = {
					Accept: "text/calendar, application/ics, text/plain;q=0.8, */*;q=0.1",
					"User-Agent": "Mailflare-Calendar-Feed/1.0",
				};
				if (options.etag) headers["If-None-Match"] = options.etag;
				if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;
				let response: Response;
				try {
					response = await fetchImpl(current.href, {
						method: "GET",
						headers,
						cache: "no-store",
						redirect: "manual",
						signal: controller.signal,
						// Only a real dispatcher key goes into init — no fabricated cf options.
						...(pin.dispatcher ? { dispatcher: pin.dispatcher } : {}),
					} as RequestInit);
				} catch {
					if (controller.signal.aborted) throw new FeedFetchError("Calendar feed request timed out", "timeout");
					throw new FeedFetchError("Could not reach the calendar feed", "fetch_failed");
				}
				if (response.status === 304) {
					await response.body?.cancel().catch(() => undefined);
					return { outcome: "not-modified", status: 304 };
				}
				if (REDIRECT_STATUSES.has(response.status)) {
					await response.body?.cancel().catch(() => undefined);
					if (redirects >= maxRedirects) throw new FeedFetchError("Calendar feed redirected too many times", "too_many_redirects");
					const location = response.headers.get("location");
					if (!location) throw new FeedFetchError("Calendar feed redirect has no location", "invalid_redirect");
					let redirected: URL;
					try {
						redirected = normalizeFeedUrl(new URL(location, current).href);
					} catch (error) {
						throw error instanceof FeedFetchError ? error : new FeedFetchError("Calendar feed redirect is invalid", "invalid_redirect");
					}
					// Redirects are https-only: an http feed may upgrade to https but never bounce back down.
					if (redirected.protocol !== "https:") throw new FeedFetchError("Calendar feed redirect must stay on https", "invalid_redirect");
					current = redirected;
					continue;
				}
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					throw new FeedFetchError(`Calendar feed returned HTTP ${response.status}`, "http_error", response.status);
				}
				let body: Uint8Array;
				try {
					body = await readLimitedBody(response, maxBytes, controller.signal);
				} catch (error) {
					if (controller.signal.aborted && !(error instanceof FeedFetchError)) throw new FeedFetchError("Calendar feed request timed out", "timeout");
					throw error;
				}
				return {
					outcome: "fetched",
					status: response.status,
					body: new TextDecoder("utf-8").decode(body),
					etag: response.headers.get("etag"),
					lastModified: response.headers.get("last-modified"),
				};
			} finally {
				// The pin lives for exactly one hop — pool entries that outlive it would re-serve a later hop.
				await pin.dispatcher?.close?.().catch(() => undefined);
			}
		}
	} finally {
		clearTimeout(timeout);
	}
}
