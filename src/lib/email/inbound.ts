import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { boundParsedEmail } from "@/lib/email/inbound-limits";
import { resolveInboundAddress, resolveInboxRuleDestination, type ResolvedMailbox } from "@/lib/email/routing";
import { deliverToMailingList } from "@/lib/email/mailing-lists";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { getMessageContactNames, upsertContactFromAddress } from "@/lib/contacts/service";
import { getEmailAddress } from "@/lib/email/address";
import { sendMailboxAutoReply } from "@/lib/email/auto-reply";
import { isOthersDraft } from "@/lib/email/draft-access";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listMessageAttachments, storeMessageAttachments } from "@/lib/email/attachments";
import { registerInboundInvite } from "@/lib/calendar/invite-store";
import { inboundAttachmentLimitReason } from "@/lib/email/inbound-attachments";
import { deleteUnreferencedRawMail, inboundMessageId, inboundStorageKey, INBOUND_STAGING_PREFIX, mailboxInboundScope } from "@/lib/email/inbound-id";
import { estimateInboundStoredBytes, INBOUND_QUOTA_REJECT_REASON, mailboxInboundQuotaExceeded } from "@/lib/email/mailbox-quota";
import { extractUnsubscribeLinkFromBody, extractUnsubscribeUrlFromRaw, getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import { resolveThreadId } from "@/lib/email/threading";
import { normalizeMessageId } from "@/lib/email/thread-lookup";
import type { SessionUser } from "@/lib/auth/types";
import { analyzeSpam } from "@/lib/spam/engine";
import { ExternalSpamIntelligenceProvider } from "@/lib/spam/providers/external";
import { getSpamIntelligenceConfig } from "@/lib/spam/settings";
import type { ProviderVerdicts } from "@/lib/spam/types";
import { getReputationKeys } from "@/lib/spam/analyzers/reputation";
import { recordReputationObservation } from "@/lib/spam/repository";
import {
	getMailboxNotificationUserIds,
	notifyUsersOfNewMessage,
} from "@/lib/realtime/utils";
import { scheduleAutoDraft } from "@/lib/agent/jobs/utils";
import { buildNewMessageNotification } from "@/lib/email/inbound-notification";

export type InboundQueueMessage = {
	from: string;
	to: string;
	/**
	 * The object holding this delivery's raw MIME. Queue events stage bytes
	 * under `inbound/staging/` — private to this event, so every cleanup path
	 * may delete it without touching another delivery's object. A member copy
	 * instead carries the mailbox-scoped canonical key the fan-out already
	 * stored. Either way a stored message row ends up referencing the canonical
	 * key the consumer derived, never this staging key.
	 */
	rawR2Key: string;
	headers?: Record<string, string>;
	verdicts?: ProviderVerdicts;
	senderIp?: string;
};

/** True when the address is a mailbox or alias owned by the user, so their own mail never counts as unread. */
export async function processInboundMessage(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
): Promise<void> {
	const db = getDb(env);
	// The sender is passed so that sender-based block rules resolve the same way here as they
	// do in the Worker email handler.
	const decision = await resolveInboundAddress(db, payload.to, payload.from);

	// Content-hash keys are shared between deliveries of identical bytes, so a
	// reject/no-route cleanup must never delete an object a stored message or a
	// sibling event still needs: deletes go through the reference check, and new
	// payloads always carry a private staging object here.
	const dropRaw = () => deleteUnreferencedRawMail(env, db, payload.rawR2Key);

	if (!decision) {
		console.warn(`No routing for inbound address: ${payload.to}`);
		await dropRaw();
		return;
	}

	if (decision.action === "reject") {
		console.warn(`Rejected inbound: ${payload.to}`);
		await dropRaw();
		return;
	}

	// A list decision fans out at the queue, where one member delivery is one
	// stored message — the same path a direct recipient takes.
	if (decision.action === "list") {
		if (!decision.list) {
			await dropRaw();
			return;
		}
		await deliverToMailingList(env, payload, decision.list, (memberPayload, mailbox) => storeInboundMessage(env, memberPayload, mailbox), { ownersOnly: decision.heldForModeration });
		return;
	}

	// A forward decision reaches the queue when the rule keeps a copy or the forward
	// failed; either way it is stored if there is a mailbox to store it in.
	if (!decision.mailbox) {
		await dropRaw();
		return;
	}
	await storeInboundMessage(env, payload, decision.mailbox);
}

/** Stores the queued raw message in `mailbox`, applying that mailbox's rules, spam analysis and notifications. */
async function storeInboundMessage(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	mailbox: ResolvedMailbox,
): Promise<void> {
	const db = getDb(env);
	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}
	const buffer = await raw.arrayBuffer();

	// The stored object lives at the canonical content key for this mailbox —
	// unless the payload already carries one (a member copy the fan-out wrote,
	// or a payload produced before staging keys existed, whose key IS the
	// stored key). Dedupe checks every key a row for these bytes could carry:
	// the payload's own key, the current mailbox-scoped canonical key (a
	// pre-change payload arriving after the equivalent staged event stored
	// under it), and the legacy unprefixed key (a replay across the format
	// change in the other direction).
	const canonicalKey = await inboundStorageKey(buffer, mailboxInboundScope(mailbox.mailboxId));
	const storedKey = payload.rawR2Key.startsWith(INBOUND_STAGING_PREFIX)
		? canonicalKey
		: payload.rawR2Key;
	const legacyKey = await inboundStorageKey(buffer, mailbox.mailboxId);
	const [stored] = await db.select({ id: messages.id, rawR2Key: messages.rawR2Key }).from(messages).where(and(
		eq(messages.mailboxId, mailbox.mailboxId),
		inArray(messages.rawR2Key, [...new Set([storedKey, canonicalKey, legacyKey])]),
	)).limit(1);
	if (stored) {
		// The source object is a duplicate delivery artifact: a staging key or
		// a re-put canonical that is not the one the stored row references.
		if (payload.rawR2Key !== stored.rawR2Key) await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		try {
			const [existing] = await db.select().from(messages).where(eq(messages.id, stored.id)).limit(1);
			if (existing && Date.now() - existing.createdAt.getTime() < 30 * 60_000) await scheduleAutoDraft(env, { mailboxId: mailbox.mailboxId, sourceMessageId: existing.id, ownerUserId: mailbox.userId, sender: existing.fromAddr, headers: payload.headers, status: existing.status, folderId: existing.folderId, spamVerdict: existing.spamVerdict, spamAnalysisError: existing.spamAnalysisError });
		} catch (error) { console.error("Auto-draft recovery failed", error); }
		return;
	}

	let parsed: Awaited<ReturnType<typeof parseRawMime>>;
	try {
		parsed = boundParsedEmail(await parseRawMime(buffer));
	} catch (error) {
		// Deterministic: a retry would repeat the same expensive parse, so drop the message.
		console.warn(`Inbound MIME rejected for ${payload.to}`, error);
		await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		return;
	}
	const attachmentLimitReason = inboundAttachmentLimitReason(parsed.attachments);
	if (attachmentLimitReason) {
		console.warn(`Inbound attachment limit reached for ${payload.to}: ${attachmentLimitReason}`);
		await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		return;
	}

	// The decisive storage-quota gate, on the same basis getMailboxUsage counts:
	// bounded parsed bodies plus attachment bytes. The pre-queue checks estimate
	// with raw size, which can lie in both directions (MIME overhead, but also
	// 8-bit encodings that decode to larger UTF-8), so it is verified here on the
	// real stored bytes before the row or any side effect exists. The drop is
	// silent — the sender's provider already accepted the mail.
	if (await mailboxInboundQuotaExceeded(env, db, mailbox.mailboxId, estimateInboundStoredBytes(parsed))) {
		console.warn(`Inbound dropped for ${payload.to}: ${INBOUND_QUOTA_REJECT_REASON}`);
		await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		return;
	}

	// Promote the staged bytes to the canonical key the row will reference.
	// Writes are idempotent — every event computing this key holds these bytes.
	if (payload.rawR2Key !== storedKey) {
		await env.BUCKET.put(storedKey, buffer, {
			httpMetadata: { contentType: "message/rfc822" },
			customMetadata: { from: payload.from, to: payload.to },
		});
	}
	const messageId = await inboundMessageId(storedKey);
	const snippet = buildSnippet(parsed.text, parsed.html);
	const deliveredAddress = getEmailAddress(payload.to) || `${mailbox.localPart}@${mailbox.hostname}`;
	// Keep the whole To header so reply-all can address everyone; rules and
	// webhooks still see the envelope recipient the message was delivered to.
	const toAddr = parsed.toAddr ?? payload.to;
	const fromAddr = parsed.fromAddr ?? payload.from;
	const destination = await resolveInboxRuleDestination(db, {
		mailboxId: mailbox.mailboxId,
		toAddress: payload.to,
		fromAddress: fromAddr,
		subject: parsed.subject,
		content: [parsed.text, parsed.html, snippet].filter(Boolean).join(" "),
	});
	let spamAnalysis: Awaited<ReturnType<typeof analyzeSpam>> | null = null;
	let spamAnalysisError: string | null = null;
	const [owner] = await db.select({ enabled: users.spamProtectionEnabled }).from(users).where(eq(users.id, mailbox.userId)).limit(1);
	if (owner?.enabled !== false) {
		try {
			const intelligence = await getSpamIntelligenceConfig(env);
			spamAnalysis = await analyzeSpam(db, {
				mailboxId: mailbox.mailboxId,
				userId: mailbox.userId,
				envelopeFrom: payload.from,
				headers: payload.headers,
				verdicts: payload.verdicts,
				senderIp: payload.senderIp,
				brands: intelligence.brands,
				message: parsed,
				intelligenceProvider: new ExternalSpamIntelligenceProvider(intelligence, env.BUCKET),
			});
		} catch (error) {
			spamAnalysisError = error instanceof Error ? error.message.slice(0, 300) : "Spam analysis failed";
			console.error(`Spam analysis failed for ${messageId}`, error);
		}
	}
	if (destination.status === "spam" && spamAnalysis) {
		spamAnalysis = {
			score: 100,
			verdict: "spam",
			signals: [{ id: "mailbox_rule_spam", score: 100, reason: "A mailbox rule marked this message as spam" }],
			fingerprint: spamAnalysis?.fingerprint ?? "",
		};
	}
	const status = destination.status === "received" && spamAnalysis?.verdict === "spam"
		? "spam"
		: destination.status;
	const folderId = status === "spam" ? null : destination.folderId;
	// A contact the database cannot hold (e.g. an over-long address) must not lose the mail.
	const contact = await upsertContactFromAddress(env, {
		userId: mailbox.userId,
		address: fromAddr,
		source: "inbound",
		// Spam senders are strangers at best; do not announce them to Gravatar.
		lookupAvatar: status !== "spam" && status !== "trash",
	}).catch((error) => {
		console.error(`Contact upsert failed for ${messageId}`, error);
		return null;
	});
	let threadId: string;
	try {
		threadId = await resolveThreadId(db, {
			mailboxId: mailbox.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
			senderAddress: getEmailAddress(fromAddr) || null,
		});
	} catch (error) {
		console.error("Inbound thread lookup failed", {
			rawR2Key: payload.rawR2Key,
			recipient: payload.to,
			referenceCount: parsed.references.length,
			error,
		});
		threadId = normalizeMessageId(parsed.messageId) ?? newId("thr");
	}

	try {
		const inserted = await db.insert(messages).values({
			id: messageId,
			userId: mailbox.userId,
			mailboxId: mailbox.mailboxId,
			folderId,
			direction: "inbound",
			providerMessageId: parsed.messageId,
			fromAddr,
			toAddr,
			ccAddr: parsed.ccAddr,
			replyTo: parsed.replyTo,
			subject: parsed.subject,
			snippet,
			textBody: parsed.text,
			htmlBody: parsed.html,
			rawR2Key: storedKey,
			status,
			// The From header is forgeable, so mail "from yourself" is not treated as already read.
			read: false,
			threadId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references.length ? parsed.references.join(" ") : null,
			hasUnsubscribe: !!extractUnsubscribeUrlFromRaw(buffer) || !!extractUnsubscribeLinkFromBody(parsed.html, parsed.text),
			spamScore: spamAnalysis?.score ?? null,
			spamVerdict: spamAnalysis?.verdict ?? null,
			spamSignals: spamAnalysis ? JSON.stringify(spamAnalysis.signals) : null,
			spamAnalyzedAt: spamAnalysis ? new Date() : null,
			spamAnalysisError,
		}).onConflictDoNothing().returning({ id: messages.id });
		if (!inserted.length) {
			// A concurrent delivery of these identical bytes beat the dedupe check
			// to the insert; this event's staging object is now unreferenced.
			if (payload.rawR2Key !== storedKey) {
				await env.BUCKET.delete(payload.rawR2Key).catch((error) => console.error(`Raw cleanup failed for ${payload.rawR2Key}`, error));
			}
			return;
		}

		await storeMessageAttachments(env, messageId, parsed.attachments);
		if (status !== "spam" && status !== "trash") {
			await registerInboundInvite(env, { userId: mailbox.userId, mailboxId: mailbox.mailboxId, messageId, senderAddress: fromAddr, attachments: parsed.attachments });
		}
		if (spamAnalysis) {
			try {
				await recordReputationObservation(env, mailbox.mailboxId, getReputationKeys(parsed, spamAnalysis.fingerprint));
			} catch (error) {
				console.error(`Spam reputation observation failed for ${messageId}`, error);
			}
			console.info(JSON.stringify({
				messageId,
				spamScore: spamAnalysis.score,
				verdict: spamAnalysis.verdict,
				signals: spamAnalysis.signals.map((signal) => signal.id),
			}));
		}
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}

	if (status === "received") {
		try {
			await sendMailboxAutoReply(env, {
				mailboxId: mailbox.mailboxId,
				userId: mailbox.userId,
				deliveredAddress,
				fromAddress: fromAddr,
				envelopeFrom: payload.from,
				incomingMessageId: parsed.messageId,
				headers: payload.headers,
			});
		} catch (error) {
			console.error(`Auto-reply failed for mailbox ${mailbox.mailboxId}`, error);
		}
	}

	if (status === "spam" || status === "trash") {
		console.info(`No notification for ${messageId}: filed as ${status}`);
	} else {
		const notificationUserIds = await getMailboxNotificationUserIds(
			env,
			mailbox.mailboxId,
			mailbox.userId,
		);
		await notifyUsersOfNewMessage(env, notificationUserIds, buildNewMessageNotification({
			messageId,
			mailboxId: mailbox.mailboxId,
			fromAddr,
			contact,
			subject: parsed.subject,
		}));
	}
	// Spam and blocked mail carry an unauthenticated From; consumers acting on it would be fooled.
	if (status !== "spam" && status !== "trash") {
		await dispatchWebhooks(env, mailbox.userId, "message.inbound", {
			messageId,
			from: fromAddr,
			to: payload.to,
			cc: parsed.ccAddr ?? undefined,
			subject: parsed.subject,
			threadId,
			spamScore: spamAnalysis?.score,
			spamVerdict: spamAnalysis?.verdict,
		});
	}
	try {
		await scheduleAutoDraft(env, { mailboxId: mailbox.mailboxId, sourceMessageId: messageId, ownerUserId: mailbox.userId, sender: fromAddr, headers: payload.headers, status, folderId, spamVerdict: spamAnalysis?.verdict, spamAnalysisError });
	} catch (error) { console.error("Auto-draft scheduling failed", error); }
	// The row now references the canonical object; the per-event staging object
	// (when there is one) is consumed. Member copies already live at storedKey.
	if (payload.rawR2Key !== storedKey) {
		await env.BUCKET.delete(payload.rawR2Key).catch((error) => console.error(`Raw cleanup failed for ${payload.rawR2Key}`, error));
	}
}

export async function getMessageWithBody(env: CloudflareEnv, userId: string, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message || message.userId !== userId) return null;
	const contactNames = await getMessageContactNames(env, userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribe = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	const [scheduledJob] = message.direction === "outbound" && message.status === "queued"
		? await db
			.select({ scheduledAt: outboundJobs.scheduledAt })
			.from(outboundJobs)
			.where(and(eq(outboundJobs.messageId, messageId), eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt)))
			.limit(1)
		: [];
	return {
		message: { ...message, ...contactNames },
		body: message,
		attachments,
		unsubscribeUrl: unsubscribe?.url ?? null,
		unsubscribeViaBody: unsubscribe ? null : extractUnsubscribeLinkFromBody(message.htmlBody, message.textBody),
		scheduledAt: scheduledJob?.scheduledAt?.toISOString() ?? null,
	};
}

export async function getMessageWithBodyForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId || isOthersDraft(message, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const [scheduledJob, contactNames, attachments, unsubscribe] = await Promise.all([
		message.direction === "outbound" && message.status === "queued"
			? db
				.select({ scheduledAt: outboundJobs.scheduledAt })
				.from(outboundJobs)
				.where(and(eq(outboundJobs.messageId, messageId), eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt)))
				.limit(1)
			: Promise.resolve([]),
		getMessageContactNames(env, message.userId, message.fromAddr, message.toAddr),
		listMessageAttachments(env, messageId),
		getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key),
	]);
	const { rawR2Key, textBody, htmlBody, ...header } = message;
	void rawR2Key;
	return {
		message: { ...header, ...contactNames },
		body: { textBody: textBody ?? null, htmlBody: htmlBody ?? null },
		attachments,
		unsubscribeUrl: unsubscribe?.url ?? null,
		unsubscribeViaBody: unsubscribe ? null : extractUnsubscribeLinkFromBody(htmlBody, textBody),
		scheduledAt: scheduledJob[0]?.scheduledAt?.toISOString() ?? null,
	};
}

export async function getMessageMetadataForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key, htmlBody: messages.htmlBody, textBody: messages.textBody, status: messages.status, privateDraft: messages.privateDraft, userId: messages.userId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isOthersDraft(message, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const [attachments, unsubscribe] = await Promise.all([
		listMessageAttachments(env, messageId),
		getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key),
	]);
	return {
		attachments,
		unsubscribeUrl: unsubscribe?.url ?? null,
		unsubscribeViaBody: unsubscribe ? null : extractUnsubscribeLinkFromBody(message.htmlBody, message.textBody),
	};
}
