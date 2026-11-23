import { eq, and, asc, desc } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, folders, mailboxAliases, mailboxes, mailingListMembers, mailingLists, routingRules } from "@/db/schema";
import { getEmailAddress, normalizeEmailAddress } from "@/lib/email/address";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import {
	normalizeRecipientFullLocalPart,
	normalizeRecipientLocalPart,
	parseRecipientAddress,
} from "@/lib/email/recipient-address";

export type ResolvedMailbox = {
	mailboxId: string;
	folderId: string | null;
	userId: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
};

export type ResolvedList = {
	listId: string;
	userId: string;
	domainId: string;
	localPart: string;
	hostname: string;
	name: string;
};

export type RoutingDecision = {
	action: "store" | "forward" | "reject" | "list";
	mailbox?: ResolvedMailbox;
	/** Set when the recipient is a mailing list; the queue fans it out to members. */
	list?: ResolvedList;
	forwardTo?: string;
	/** Forward rules drop the message unless the rule also keeps a copy in the mailbox. */
	keepCopy?: boolean;
	rejectReason?: string;
	/** Set when a domain-scope rule produced this decision, so the caller can record a match. */
	ruleId?: string;
	/**
	 * Set on a list decision when the post is held for review: it is accepted but
	 * fans out only to the list's owner members, not the full membership. A
	 * moderated list holds every allowed post; a moderated member holds theirs.
	 */
	heldForModeration?: boolean;
};

export type InboxRuleDestination = {
	status: "received" | "spam" | "trash";
	folderId: string | null;
};

type RuleRow = typeof routingRules.$inferSelect;

export type RuleMatchInput = {
	toAddress: string;
	fromAddress?: string | null;
	subject?: string | null;
	content?: string | null;
};

export type ResolveInboundOptions = {
	/**
	 * Apply the mailbox owner's own forwarding rules. Only the receiving handlers set this:
	 * they can still forward the live message, and they know the subject.
	 *
	 * `from` is the From header. Folder, spam and trash rules match the From header, so a
	 * forward rule on the same sender field must match it too, not only the envelope
	 * sender, which bulk senders set to a bounce address the user never sees.
	 */
	mailboxForwards?: { subject?: string | null; from?: string | null };
	/**
	 * Skip posting authorization and moderation on a list claim, returning the
	 * plain list decision. Internal callers that resolve an address only to learn
	 * whether it maps to a mailbox (the sender and member lookups inside the
	 * posting check itself) set this so the checks cannot recurse; real delivery
	 * decisions never do.
	 */
	skipPostingAuth?: boolean;
};

/**
 * Resolves what should happen to an inbound message addressed to `toAddress`.
 *
 * Domain-scope rules are evaluated in three phases so that a broad catch-all can never
 * shadow a real mailbox:
 *   1. `reject` rules (block lists) — highest precedence, evaluated before delivery.
 *   2. a literal `local+tag` mailbox or enabled mailing list claims a tagged
 *      address first; then the `local` base claims — exact mailbox, mailbox
 *      aliases, an enabled base mailing list. A disabled mailbox, alias or
 *      list claims nothing. Multi-domain mailbox aliases come after all of
 *      them. An empty-tag `local+` address is literal-only for lists: the
 *      `local` base list never claims it.
 *   3. remaining `forward` / `store` rules — the catch-all fallback.
 * Within each phase rules run by descending priority, then oldest first.
 */
export async function resolveInboundAddress(
	db: AppDatabase,
	toAddress: string,
	fromAddress?: string | null,
	options: ResolveInboundOptions = {},
): Promise<RoutingDecision | null> {
	const parsed = parseRecipientAddress(toAddress);
	if (!parsed) return null;

	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);

	if (!domain) return null;

	const domainRules = await listDomainRules(db, domain.id);
	const matchInput: RuleMatchInput = { toAddress, fromAddress };

	// Phase 1 — block rules run before any mailbox lookup so they can block a sender
	// even when the recipient is a real mailbox.
	for (const rule of domainRules) {
		if (rule.action !== "reject") continue;
		if (!matchesRule(rule, matchInput)) continue;
		return {
			action: "reject",
			rejectReason: rule.rejectReason?.trim() || "Message rejected by routing rule",
			ruleId: rule.id,
		};
	}

	// Phase 2 — a real mailbox always wins over a catch-all. Literal `user+tag`
	// claims come before every `user` base claim below, the same exact-then-base
	// order the plus-addressing pass (#416) applies to all claimants once it
	// lands: a `user+tag` mailbox, then a `user+tag` mailing list.
	const exactMailboxes = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.disabled, false)));
	const taggedMailbox = parsed.fullLocalPart !== parsed.localPart
		? exactMailboxes.find(
			(mailbox) => normalizeRecipientFullLocalPart(mailbox.localPart) === parsed.fullLocalPart,
		)
		: undefined;
	// An enabled list stored under the address's literal `+` form — `user+tag`,
	// or `user+` with an empty tag — claims it before every enabled base claim
	// underneath: exact tagged list > enabled alias paths > base list. A
	// non-empty tag still reaches the `user` base list behind the claims below,
	// but `user+` is literal-only for lists, mirroring the plus-addressing
	// pass: it never falls back to `user`. On this base the mailbox and alias
	// claims still strip `+` to base, so `user+` mail lands in the `user`
	// mailbox when no `user+` claimant exists — lists and mailboxes behave
	// uniformly once #416 merges.
	if (!taggedMailbox && parsed.fullLocalPart !== parsed.localPart) {
		const list = await findEnabledMailingList(db, domain.id, parsed.fullLocalPart);
		if (list) return listClaimDecision(db, list, domain, fromAddress, options);
	}
	const exactMailbox = exactMailboxes.find(
		(mailbox) => normalizeRecipientLocalPart(mailbox.localPart) === parsed.localPart,
	);
	let mailbox = taggedMailbox ?? exactMailbox ?? await resolveMailboxAlias(db, domain.id, parsed.localPart);
	// A disabled alias keeps owning its address: reject instead of letting a
	// use-all-domains mailbox or a catch-all rule deliver its mail elsewhere.
	if (!mailbox && await findDisabledAlias(db, domain.id, parsed.localPart)) {
		return { action: "reject", rejectReason: "Mailbox unavailable" };
	}
	// A mailing list claims the address the same way a mailbox or alias does, so
	// it wins over the implicit use-all-domains claim and the catch-all rules
	// below, and a disabled list — like a disabled mailbox — simply does not
	// match. For a `user+tag` address this is the `user` base fallback behind
	// the literal lookup above: `user+x` resolves to it only when no `user+x`
	// list exists. Only a lone empty tag skips this pass — `user+` is
	// literal-only for lists, but `user++` and `user+x+` carry real tags and
	// fall back to `user` like any other subaddress.
	if (!mailbox && (parsed.hasSubaddress || !parsed.fullLocalPart.endsWith("+"))) {
		const list = await findEnabledMailingList(db, domain.id, parsed.localPart);
		if (list) return listClaimDecision(db, list, domain, fromAddress, options);
	}
	mailbox ??= await resolveMailboxDomainAlias(db, parsed.localPart, parsed.normalizedAddress);

	if (mailbox) {
		const resolved = toResolvedMailbox(mailbox, domain.id, domain.hostname);
		const forward = options.mailboxForwards
			? await findMailboxForward(
				db,
				mailbox.id,
				{ ...matchInput, subject: options.mailboxForwards.subject },
				options.mailboxForwards.from,
			)
			: null;
		if (forward?.forwardTo) {
			return {
				action: "forward",
				forwardTo: forward.forwardTo,
				keepCopy: forward.keepCopy,
				mailbox: resolved,
				ruleId: forward.id,
			};
		}
		return { action: "store", mailbox: resolved };
	}

	// Phase 3 — catch-all and forwarding fallbacks.
	for (const rule of domainRules) {
		if (rule.action !== "forward" && rule.action !== "store") continue;
		if (!matchesRule(rule, matchInput)) continue;

		if (rule.action === "forward") {
			const forwardTo = rule.forwardTo?.trim();
			if (!forwardTo) continue;
			const catchAll = rule.mailboxId ? await getRuleMailbox(db, rule.mailboxId, domain.id) : null;
			return {
				action: "forward",
				forwardTo,
				keepCopy: rule.keepCopy && !!catchAll,
				mailbox: catchAll ?? undefined,
				ruleId: rule.id,
			};
		}

		if (!rule.mailboxId) continue;
		const catchAll = await getRuleMailbox(db, rule.mailboxId, domain.id);
		if (!catchAll) continue;
		return { action: "store", mailbox: catchAll, ruleId: rule.id };
	}

	return null;
}

/**
 * The first enabled forward rule of a mailbox that matches, by descending priority.
 * A sender condition matches either the envelope sender or the From header.
 */
async function findMailboxForward(
	db: AppDatabase,
	mailboxId: string,
	input: RuleMatchInput,
	headerFrom?: string | null,
): Promise<RuleRow | null> {
	const rules = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, mailboxId),
				eq(routingRules.scope, "mailbox"),
				eq(routingRules.action, "forward"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
	return rules.find((rule) => rule.forwardTo?.trim() && matchesForwardRule(rule, input, headerFrom)) ?? null;
}

function matchesForwardRule(
	rule: MatchableRule,
	input: RuleMatchInput,
	headerFrom?: string | null,
): boolean {
	if (matchesRule(rule, input)) return true;
	if (!headerFrom?.trim()) return false;
	return matchesRule(rule, { ...input, fromAddress: headerFrom });
}

async function listDomainRules(db: AppDatabase, domainId: string): Promise<RuleRow[]> {
	return db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.domainId, domainId),
				eq(routingRules.scope, "domain"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
}

async function getRuleMailbox(
	db: AppDatabase,
	mailboxId: string,
	domainId: string,
): Promise<ResolvedMailbox | null> {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.disabled, false)))
		.limit(1);
	if (!mailbox) return null;

	const [domain] = await db
		.select({ hostname: domains.hostname })
		.from(domains)
		.where(eq(domains.id, domainId))
		.limit(1);
	if (!domain) return null;

	return toResolvedMailbox(mailbox, domainId, domain.hostname);
}

function toResolvedMailbox(
	mailbox: typeof mailboxes.$inferSelect,
	domainId: string,
	hostname: string,
): ResolvedMailbox {
	return {
		mailboxId: mailbox.id,
		folderId: null,
		userId: mailbox.userId,
		domainId,
		localPart: mailbox.localPart,
		hostname,
		displayName: mailbox.displayName,
	};
}

/** Records that a domain rule fired, for the "last matched" column in the routing UI. */
export async function recordRuleMatch(db: AppDatabase, ruleId: string): Promise<void> {
	const [rule] = await db
		.select({ matchCount: routingRules.matchCount })
		.from(routingRules)
		.where(eq(routingRules.id, ruleId))
		.limit(1);
	if (!rule) return;
	await db
		.update(routingRules)
		.set({ matchCount: rule.matchCount + 1, lastMatchedAt: new Date() })
		.where(eq(routingRules.id, ruleId));
}

async function resolveMailboxAlias(db: AppDatabase, domainId: string, localPart: string) {
	const rows = await db
		.select({ mailbox: mailboxes, aliasLocalPart: mailboxAliases.localPart })
		.from(mailboxAliases)
		.innerJoin(mailboxes, eq(mailboxAliases.mailboxId, mailboxes.id))
		.where(and(
			eq(mailboxAliases.domainId, domainId),
			eq(mailboxAliases.enabled, true),
			eq(mailboxes.disabled, false),
		));
	const row = rows.find(
		(item) => normalizeRecipientLocalPart(item.aliasLocalPart) === localPart,
	);
	return row?.mailbox ?? null;
}

async function findDisabledAlias(db: AppDatabase, domainId: string, localPart: string): Promise<boolean> {
	const rows = await db
		.select({ localPart: mailboxAliases.localPart })
		.from(mailboxAliases)
		.where(and(eq(mailboxAliases.domainId, domainId), eq(mailboxAliases.enabled, false)));
	return rows.some((row) => normalizeRecipientLocalPart(row.localPart) === localPart);
}

// Stored list local parts normalize with the tag kept, so a stored `team+x`
// claims `team+x` and never the `team` base — the same treatment the
// plus-addressing pass gives stored mailbox and alias local parts.
async function findEnabledMailingList(db: AppDatabase, domainId: string, localPart: string) {
	const rows = await db
		.select()
		.from(mailingLists)
		.where(and(eq(mailingLists.domainId, domainId), eq(mailingLists.disabled, false)));
	return rows.find((list) => normalizeRecipientFullLocalPart(list.localPart) === localPart) ?? null;
}

function toResolvedList(
	list: typeof mailingLists.$inferSelect,
	domain: typeof domains.$inferSelect,
): ResolvedList {
	return {
		listId: list.id,
		userId: list.userId,
		domainId: domain.id,
		localPart: list.localPart,
		hostname: domain.hostname,
		name: list.name,
	};
}

/**
 * A list claim is a posting: the sender's right to post is decided here, before
 * fan-out, so an unauthorized post gets the same reject decision a domain block
 * rule produces (an SMTP-level reject where the receiver can still issue one).
 */
async function listClaimDecision(
	db: AppDatabase,
	list: typeof mailingLists.$inferSelect,
	domain: typeof domains.$inferSelect,
	fromAddress: string | null | undefined,
	options: ResolveInboundOptions,
): Promise<RoutingDecision> {
	if (options.skipPostingAuth) return { action: "list", list: toResolvedList(list, domain) };
	const posting = await checkListPosting(db, list, fromAddress);
	if (posting === "deny") {
		return { action: "reject", rejectReason: "Sender is not a member of this mailing list" };
	}
	return { action: "list", list: toResolvedList(list, domain), heldForModeration: posting === "hold" };
}

type ListPostingOutcome = "allow" | "hold" | "deny";

/**
 * Who may post to a list. Membership is established two ways, matching the
 * sender-dedup semantics in the delivery engine: the envelope sender's address
 * literally appears as a member email, or it resolves to the same mailbox a
 * member email resolves to — a member subscribed under one address can post
 * from any other address or alias of that mailbox, plus-tags included.
 *
 * A `members_only` list denies a sender matching neither path, including an
 * empty or unparseable envelope sender. `anyone` posts freely — the member scan
 * still runs there only when a moderated flag exists, because a moderated
 * member's posts are held under every policy. A list-level `moderated` flag
 * holds every allowed post. When several member rows map to the sender's
 * mailbox, any moderated one holds the post.
 *
 * Only useful member rows are resolved: once membership is proven, unmoderated
 * rows cannot change the outcome, and an open list with no moderation anywhere
 * never resolves at all.
 */
async function checkListPosting(
	db: AppDatabase,
	list: typeof mailingLists.$inferSelect,
	envelopeFrom: string | null | undefined,
): Promise<ListPostingOutcome> {
	const membersOnly = list.postingPolicy === "members_only";
	const members = await db
		.select({ email: mailingListMembers.email, moderated: mailingListMembers.moderated })
		.from(mailingListMembers)
		.where(eq(mailingListMembers.listId, list.id));

	const sender = normalizeEmailAddress(envelopeFrom ?? "");
	const matched = new Set(members.filter((member) => normalizeEmailAddress(member.email) === sender));
	let memberFound = matched.size > 0;
	let hold = list.moderated || [...matched].some((member) => member.moderated);

	// Member resolution can still change the outcome while a members-only
	// sender has no match yet, or an unmatched moderated row could still hold.
	const worthScanning = (membersOnly && !memberFound) || (!hold && members.some((member) => member.moderated && !matched.has(member)));
	if (worthScanning && sender) {
		const senderMailbox = (await resolveInboundAddress(db, sender, null, { skipPostingAuth: true }))?.mailbox;
		if (senderMailbox) {
			for (const member of members) {
				if (matched.has(member)) continue;
				if (!((membersOnly && !memberFound) || (member.moderated && !hold))) continue;
				const decision = await resolveInboundAddress(db, member.email, null, { skipPostingAuth: true });
				if (decision?.mailbox?.mailboxId !== senderMailbox.mailboxId) continue;
				matched.add(member);
				memberFound = true;
				if (member.moderated) hold = true;
			}
		}
	}
	if (membersOnly && !memberFound) return "deny";
	return hold ? "hold" : "allow";
}

async function resolveMailboxDomainAlias(
	db: AppDatabase,
	localPart: string,
	normalizedAddress: string,
) {
	const candidates = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.useAllDomains, true), eq(mailboxes.disabled, false)));

	for (const mailbox of candidates) {
		if (normalizeRecipientLocalPart(mailbox.localPart) !== localPart) continue;
		const addresses = await getMailboxDomainAddresses(db, mailbox);
		if (addresses.some((address) => parseRecipientAddress(address)?.normalizedAddress === normalizedAddress)) {
			return mailbox;
		}
	}
	return null;
}

export async function resolveInboxRuleDestination(
	db: AppDatabase,
	input: {
		mailboxId: string;
		toAddress: string;
		fromAddress?: string | null;
		subject?: string | null;
		content?: string | null;
	},
): Promise<InboxRuleDestination> {
	const rules = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, input.mailboxId),
				eq(routingRules.scope, "mailbox"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));

	for (const rule of rules) {
		if (rule.action === "forward") continue;
		if (!matchesRule(rule, input)) continue;

		if (rule.action === "spam" || rule.action === "trash") {
			return { status: rule.action, folderId: null };
		}

		if (!rule.folderId) continue;
		const folderId = await getRuleFolderId(db, rule.folderId, input.mailboxId);
		if (!folderId) continue;
		return { status: "received", folderId };
	}

	return { status: "received", folderId: null };
}

type MatchableRule = {
	pattern: string;
	matchField?: string | null;
	matchOperator?: string | null;
	matchValue?: string | null;
};

export function matchesRule(rule: MatchableRule, input: RuleMatchInput): boolean {
	const rawValue = (rule.matchValue || rule.pattern).trim();
	// "*" is the catch-all pattern used by catch-all and block-everything rules.
	if (rawValue === "*") return true;
	const normalizedRuleValue = normalizeRuleComparisonValue(rule.matchField, rawValue);
	if (!normalizedRuleValue) return false;

	const values = getRuleFieldValues(rule.matchField, input);
	return values.some((value) => {
		if (!value) return false;
		const normalizedValue = normalizeRuleComparisonValue(rule.matchField, value);
		if (!normalizedValue) return false;
		return compareRuleValue(rule.matchOperator, normalizedValue, normalizedRuleValue, rawValue);
	});
}

function compareRuleValue(
	operator: string | null | undefined,
	value: string,
	ruleValue: string,
	rawRuleValue: string,
): boolean {
	switch (operator) {
		case "exact":
			return value === ruleValue;
		case "starts_with":
			return value.startsWith(ruleValue);
		case "ends_with":
			return value.endsWith(ruleValue);
		case "regex":
			return matchesRegex(value, rawRuleValue);
		default:
			return value.includes(ruleValue);
	}
}

/**
 * Rule patterns are operator-authored but still untrusted enough to warrant guarding:
 * an invalid pattern must not throw and take down inbound processing.
 */
function matchesRegex(value: string, pattern: string): boolean {
	try {
		return new RegExp(pattern, "i").test(value);
	} catch {
		return false;
	}
}

function normalizeRuleComparisonValue(field: string | null | undefined, value: string | null | undefined): string {
	if (!value) return "";
	if (field === "email" || field === "sender" || field === "recipient") {
		return getEmailAddress(value).trim().toLowerCase();
	}
	return value.toLowerCase();
}

function getRuleFieldValues(field: string | null | undefined, input: RuleMatchInput) {
	if (field === "content") return [input.content];
	if (field === "title") return [input.subject];
	if (field === "sender") return [input.fromAddress];
	if (field === "recipient") return [input.toAddress];
	return [input.fromAddress, input.toAddress];
}

async function getRuleFolderId(
	db: AppDatabase,
	folderId: string,
	mailboxId: string,
): Promise<string | null> {
	const [folder] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))
		.limit(1);
	return folder?.id ?? null;
}
