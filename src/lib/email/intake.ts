import { getDb } from "@/db";
import { forwardedMarker, getAccountForwardingDestination, isForwardedMarkerValid, MAILFLARE_FORWARDED_HEADER } from "@/lib/email/account-forwarding";
import { resolveIncomingMail } from "@/lib/email/incoming";
import { INBOUND_QUOTA_REJECT_REASON, mailboxInboundQuotaExceeded } from "@/lib/email/mailbox-quota";
import { inboundStagingKey } from "@/lib/email/inbound-id";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import type { IntakeActions, IntakeInput, IntakeResult } from "@/lib/email/intake-types";

/**
 * What the Worker `email` handler does, for runtimes that hand us the whole
 * message as bytes (an SMTP listener, or the Cloudflare relay webhook):
 * resolve domain rules, act on reject and forward through the supplied
 * callbacks, then store the raw MIME and enqueue it for parsing.
 */
export async function intakeIncomingMail(env: CloudflareEnv, input: IntakeInput, actions: IntakeActions): Promise<IntakeResult> {
	const alreadyForwarded = await isForwardedMarkerValid(env, input.headers[MAILFLARE_FORWARDED_HEADER.toLowerCase()] ?? input.headers[MAILFLARE_FORWARDED_HEADER]);
	const marker = { [MAILFLARE_FORWARDED_HEADER]: await forwardedMarker(env) };
	const decision = await resolveIncomingMail(env, input.from, input.to, {
		subject: input.headers.subject,
		from: input.headers.from,
		alreadyForwarded,
	});

	if (decision?.action === "reject") {
		const reason = decision.rejectReason ?? "Message rejected by routing rule";
		await actions.reject?.(reason);
		return { action: "reject", reason };
	}

	let forwardedTo: string | null = null;
	if (decision?.action === "forward" && decision.forwardTo) {
		const forwarded = await actions.forward?.(decision.forwardTo, marker);
		if (forwarded) forwardedTo = decision.forwardTo;
		if (forwarded && !decision.keepCopy) return { action: "forward", forwardedTo };
	}

	// Same gate as the Worker email handler: everything below stores a copy, which a
	// mailbox over its storage cap cannot take. The relay route answers with action
	// "reject" so it can setReject; the SMTP listener only drops the recipient (the
	// envelope was already accepted at RCPT); provider intake drops the same way —
	// the provider already accepted the mail over SMTP.
	// Raw size is only a best-effort estimate here — the decisive parsed-bytes check
	// runs in the queue consumer.
	if (decision?.mailbox && await mailboxInboundQuotaExceeded(env, getDb(env), decision.mailbox.mailboxId, input.raw.byteLength)) {
		await actions.reject?.(INBOUND_QUOTA_REJECT_REASON);
		return { action: "reject", reason: INBOUND_QUOTA_REJECT_REASON };
	}

	if (!alreadyForwarded) {
		const destination = await getAccountForwardingDestination(env, input.to);
		if (destination) await actions.forward?.(destination, marker);
	}

	// The raw stages under a per-event key — private to this delivery, so the
	// consumer's reject/no-route cleanup can never delete an object a sibling
	// event or a stored message references. The consumer derives the canonical
	// content-hash key (scoped by mailbox) that the stored row dedupes on.
	const rawR2Key = inboundStagingKey();
	await env.BUCKET.put(rawR2Key, input.raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from: input.from, to: input.to },
	});
	const payload: InboundQueueMessage = { from: input.from, to: input.to, rawR2Key, headers: input.headers, verdicts: input.verdicts, senderIp: input.senderIp };
	await env.INBOUND_QUEUE.send(payload);
	return { action: "store", rawR2Key, forwardedTo };
}
