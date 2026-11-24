import { readFileSync } from "node:fs";
import { SMTPServer } from "smtp-server";
import type { SMTPServerSession } from "smtp-server";
import { intakeIncomingMail } from "@/lib/email/intake";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import { INBOUND_QUOTA_REJECT_REASON, mailboxInboundQuotaExceeded } from "@/lib/email/mailbox-quota";
import { recordRuleMatch, resolveInboundAddress, type RoutingDecision } from "@/lib/email/routing";
import { isPublicIpv4 } from "@/lib/spam/domain-utils";
import { getDb, type AppDatabase } from "@/db";
import { domains, routingRules } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { verifySmtpAuthentication } from "./smtp-auth";
import type { Mailer } from "./mailer";

const MAX_CLIENTS = 100;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_RECIPIENTS = 50;
const SOCKET_TIMEOUT_MS = 60_000;

/** Headers a sender can write but only the receiving side may vouch for. */
const UNTRUSTED_HEADERS = ["authentication-results", "received-spf", "arc-authentication-results", "received"];

/**
 * Receive mail directly on port 25 (or wherever SMTP_INBOUND_PORT points).
 * One inbound connection per message; each envelope recipient is handed to
 * the same intake the Cloudflare handler uses. A recipient a reject rule
 * blocks gets a 550 at RCPT TO, so the sender sees the routing rule's reason.
 */
export function startSmtpListener(
	env: CloudflareEnv,
	mailer: Mailer,
	options: { port: number; host?: string; maxSize: number; hostname?: string; tls: { keyPath: string; certPath: string } | null },
) {
	// STARTTLS is only offered with a real certificate; smtp-server's built-in
	// one has a public private key, and advertising it would mislead senders.
	const connectionsByIp = new Map<string, number>();
	// Only sessions that were admitted are counted, so rejected ones cannot decrement on close.
	const admittedSessions = new Set<string>();
	const server = new SMTPServer({
		maxClients: MAX_CLIENTS,
		socketTimeout: SOCKET_TIMEOUT_MS,
		onConnect(session, callback) {
			const ip = session.remoteAddress;
			const count = (connectionsByIp.get(ip) ?? 0) + 1;
			// maxClients in smtp-server admits one connection past the limit, so enforce it here too.
			if (count > MAX_CONNECTIONS_PER_IP || admittedSessions.size >= MAX_CLIENTS) {
				callback(Object.assign(new Error("Too many connections"), { responseCode: 421 }));
				return;
			}
			admittedSessions.add(session.id);
			connectionsByIp.set(ip, count);
			callback();
		},
		onClose(session) {
			if (!admittedSessions.delete(session.id)) return;
			const ip = session.remoteAddress;
			const count = (connectionsByIp.get(ip) ?? 1) - 1;
			if (count <= 0) connectionsByIp.delete(ip);
			else connectionsByIp.set(ip, count);
		},
		onRcptTo(address, session, callback) {
			if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) {
				callback(Object.assign(new Error("Too many recipients"), { responseCode: 452 }));
				return;
			}
			const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
			const declaredSize = Number(session.envelope.mailFrom ? (session.envelope.mailFrom.args as { SIZE?: string }).SIZE : undefined);
			recipientRejectReason(env, from, address.address, Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : 0).then(
				(reason) => callback(reason ? Object.assign(new Error(reason), { responseCode: 550 }) : undefined),
				(error) => {
					console.error("SMTP recipient lookup failed", error);
					callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
				},
			);
		},
		name: options.hostname,
		authOptional: true,
		disabledCommands: options.tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
		...(options.tls ? { key: readFileSync(options.tls.keyPath), cert: readFileSync(options.tls.certPath) } : {}),
		size: options.maxSize,
		banner: "Mailflare",
		onData(stream, session: SMTPServerSession, callback) {
			const chunks: Buffer[] = [];
			let received = 0;
			stream.on("data", (chunk: Buffer) => {
				// Stop buffering once over the limit; the 552 is sent when the stream ends.
				received += chunk.length;
				if (received <= options.maxSize) chunks.push(chunk);
				else chunks.length = 0;
			});
			stream.on("end", async () => {
				if (stream.sizeExceeded) {
					const error = Object.assign(new Error("Message exceeds size limit"), { responseCode: 552 });
					callback(error);
					return;
				}
				const raw = Buffer.concat(chunks);
				let attachmentLimitReason: string | null;
				try {
					attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(toArrayBuffer(raw));
				} catch (error) {
					console.error("SMTP attachment inspection failed", error);
					callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
					return;
				}
				if (attachmentLimitReason) {
					callback(Object.assign(new Error(attachmentLimitReason), { responseCode: 552 }));
					return;
				}
				const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
				const headers = parseHeaders(raw);
				// No SPF/DKIM/DMARC verification happens here, so anything the sender wrote is untrusted.
				for (const name of UNTRUSTED_HEADERS) delete headers[name];
				const senderIp = isPublicIpv4(session.remoteAddress) ? session.remoteAddress : undefined;
				const verdicts = await verifySmtpAuthentication(raw, {
					ip: session.remoteAddress,
					helo: session.hostNameAppearsAs,
					sender: from,
					mta: options.hostname,
				});
				let delivered = 0;
				let dropReason: string | null = null;
				const forward = async (destination: string, extra: Record<string, string>) => {
					const sent = await mailer.sendRaw(from, destination, prependHeaders(raw, extra));
					// A completed sendRaw delivered the message even when the local copy
					// is refused afterwards — count the side effect here, independently
					// of the verdict intake ends up returning.
					if (sent) delivered += 1;
					return sent;
				};
				for (const recipient of session.envelope.rcptTo) {
					const result = await intakeIncomingMail(
						env,
						{ from, to: recipient.address, raw: toArrayBuffer(raw), headers, senderIp, verdicts },
						{ forward },
					).catch((error) => {
						console.error(`SMTP intake failed for ${recipient.address}`, error);
						return null;
					});
					if (!result) {
						callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
						return;
					}
					// Every recipient here was already accepted at RCPT TO, so a reject
					// result (a mailbox over its storage cap, or a block rule created
					// mid-transaction) drops that recipient only. A transaction-wide
					// 550 would falsely report failure for recipients already stored.
					if (result.action === "reject") {
						console.warn(`SMTP recipient ${recipient.address} dropped at DATA: ${result.reason}`);
						dropReason ??= result.reason;
						continue;
					}
					// A queued copy is a side effect; a "forward" return already
					// counted its completed sendRaw in the callback above.
					if (result.action === "store") delivered += 1;
				}
				// ...but when every accepted recipient dropped and nothing was stored,
				// queued or forwarded anywhere, answering "queued" would lie. DATA is
				// still a bounce surface: report the failure a Worker setReject would
				// have made.
				if (delivered === 0) {
					callback(Object.assign(new Error(dropReason ?? "Message rejected"), { responseCode: 550 }));
					return;
				}
				callback();
			});
		},
	});
	server.on("error", (error) => console.error("SMTP listener error", error));
	server.listen(options.port, options.host ?? "0.0.0.0", () => {
		console.log(`SMTP inbound listening on ${options.host ?? "0.0.0.0"}:${options.port}`);
	});
	return server;
}

/**
 * Why a recipient is refused at RCPT TO, or null to accept it. Unknown domains are refused so
 * nothing is buffered for mail we would drop anyway. Reject rules only look at the envelope, so
 * they are applied here too: DATA has one reply for every recipient, and a 550 there would tell
 * the sender that recipients we already stored never got the message. The mailbox storage cap
 * is the same kind of per-recipient verdict: usage already over it (plus the declared SIZE when
 * the client sent one) refuses the recipient here. When only the real size tips the mailbox
 * over, the recipient was already accepted and intake drops that copy instead.
 */
async function recipientRejectReason(env: CloudflareEnv, from: string, to: string, declaredSize: number): Promise<string | null> {
	const db = getDb(env);
	const hostname = to.slice(to.lastIndexOf("@") + 1).toLowerCase();
	const [domain] = await db.select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname)).limit(1);
	if (!domain) return "Relay access denied";
	const decision = await resolveInboundAddress(db, to, from);
	if (decision?.action === "reject") {
		if (decision.ruleId) await recordRuleMatch(db, decision.ruleId).catch(() => undefined);
		return decision.rejectReason ?? "Message rejected by routing rule";
	}
	if (decision?.mailbox && await willStoreCopyAtData(db, decision) && await mailboxInboundQuotaExceeded(env, db, decision.mailbox.mailboxId, declaredSize)) {
		return INBOUND_QUOTA_REJECT_REASON;
	}
	return null;
}

/**
 * True when an RCPT-time routing decision definitely lands a copy in its mailbox.
 * A domain-rule store or keep-copy forward resolves identically at DATA — domain
 * rules match on envelope fields only — so those always store. A mailbox reached
 * directly is only provisionally a store while it has enabled mailbox-scope
 * forward rules: they match on headers DATA hasn't seen and can rewrite the
 * delivery to a pure forward that stores nothing. Pure forwards store nothing
 * and never gate on quota; unresolved decisions let the DATA path decide.
 */
async function willStoreCopyAtData(db: AppDatabase, decision: RoutingDecision): Promise<boolean> {
	if (!decision.mailbox) return false;
	if (decision.action === "forward") return decision.keepCopy === true;
	if (decision.action !== "store") return false;
	if (decision.ruleId !== undefined) return true;
	const [rule] = await db
		.select({ id: routingRules.id })
		.from(routingRules)
		.where(and(
			eq(routingRules.mailboxId, decision.mailbox.mailboxId),
			eq(routingRules.scope, "mailbox"),
			eq(routingRules.action, "forward"),
			eq(routingRules.enabled, true),
		))
		.limit(1);
	return !rule;
}

/** Header map in the shape the Worker handler provides: lower-cased names, folded lines joined. */
export function parseHeaders(raw: Buffer): Record<string, string> {
	const text = new TextDecoder("latin1").decode(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
	const end = text.search(/\r?\n\r?\n/);
	const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
	const headers: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const name = line.slice(0, index).trim().toLowerCase();
		if (!(name in headers)) headers[name] = line.slice(index + 1).trim();
	}
	return headers;
}

/**
 * Put extra headers on top of the raw message, the way the Worker's `message.forward(to, headers)`
 * does. The X-Mailflare-Forwarded marker rides here; without it two mailboxes forwarding to each
 * other bounce the message back and forth forever.
 */
export function prependHeaders(raw: Buffer, headers: Record<string, string>): Buffer {
	const lines = Object.entries(headers)
		// A header value must not carry its own line breaks into the message.
		.map(([name, value]) => `${name}: ${value.replace(/[\r\n]+/g, " ")}\r\n`)
		.join("");
	return lines ? Buffer.concat([Buffer.from(lines, "latin1"), raw]) : raw;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
