import { and, asc, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, mailboxes, mailingListMembers } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { deleteUnreferencedRawMail, heldInboundKey, inboundStorageKey, mailboxInboundScope } from "@/lib/email/inbound-id";
import { resolveInboundAddress, resolveMailboxIdentity, type ResolvedList, type ResolvedMailbox } from "@/lib/email/routing";
import type { InboundQueueMessage } from "@/lib/email/inbound";

/**
 * Nested lists are expanded recursively, not just one level: a member address
 * that names another list contributes that list's members to the delivery
 * set. Expansions are cached as results rather than visited flags — cycle
 * detection lives on the DFS stack — and a member list that itself holds
 * the post contributes nothing to the caller's expansion: it registers a
 * held record instead, and all held branches settle in a single pass once
 * traversal ends, so no reach order can preempt a designated reviewer or
 * commit a fallback from incomplete information. The depth cap bounds the
 * member queries a pathological chain can cost in one inbound delivery.
 */
const MAX_LIST_EXPANSION_DEPTH = 5;

/** One member mailbox a list copy is stored to, addressed as subscribed. */
export type MailingListDelivery = {
	/** The member email as stored on the (possibly nested) list, normalized. */
	address: string;
	mailbox: ResolvedMailbox;
};

export type SkippedListMember = {
	email: string;
	/** "external" also covers unparseable addresses and forward-only resolutions. */
	reason: "external" | "rejected" | "already-expanded" | "too-deep";
};

export type MailingListExpansion = {
	deliveries: MailingListDelivery[];
	skipped: SkippedListMember[];
	/**
	 * Lists whose own hold produced no deliverable reviewer — neither an owner
	 * member nor the list's owning user. The caller retains the raw object
	 * under `held/<listId>/` for each, so a held post is never silently
	 * discarded no matter how deeply the holding list is nested.
	 */
	retained: ResolvedList[];
};

/**
 * The restriction an expansion ran under. "restricted" means only owner-role
 * member rows were expanded (a held post's reviewer set); "full" means every
 * member row.
 */
type ExpansionRestriction = "restricted" | "full";

/**
 * One resolved member mailbox plus the context that produced it. `viaHold`
 * marks a held branch's reviewer copy — sender suppression must never strip
 * those, they are the moderation notice; expansion entries never carry it
 * (held members do not merge into expansion maps) so it only appears inside
 * held records' folded reviewer sets. `ownerReachable` marks a delivery a
 * restricted pass over the same member rows would also produce, which is
 * what lets a cached full expansion answer a later restricted query.
 */
type CachedDelivery = {
	delivery: MailingListDelivery;
	viaHold: boolean;
	ownerReachable: boolean;
};

/**
 * A computed member expansion, cached separately from traversal bookkeeping:
 * an entry is reuse-safe for any query at a depth at least the one it was
 * computed at, because a deeper compute only ever had less budget — a
 * shallower query instead recomputes and overwrites, so converging paths
 * converge on the union regardless of which ran first.
 */
type CachedExpansion = {
	depth: number;
	entries: Map<string, CachedDelivery>;
};

/**
 * Per-list record for a nested list that holds the post. Records only gather
 * inputs during traversal — the direct restricted-scan entries and the held
 * lists its member rows designated as reviewer sources — so nothing about the
 * hold is decided mid-expansion: suppression, fallback and retention all run
 * in a finalization pass once every reach is known, which is what makes an
 * over-depth reach or an in-progress cycle incapable of manufacturing a
 * fallback beside a real reviewer.
 */
type HeldRecord = {
	list: ResolvedList;
	/**
	 * Direct restricted-scan entries unioned across every eligible compute.
	 * Held members contribute through `deps` instead — entries here are only
	 * mailbox deliveries, so `viaHold` is always false on them.
	 */
	entries: Map<string, CachedDelivery>;
	/**
	 * Held lists this list's member scan designated as reviewer sources,
	 * recorded whenever the scan runs — including over-depth and cycle
	 * re-entries — so a parent hold's dependency set is the same no matter
	 * which reach order discovered it.
	 */
	deps: Set<string>;
	/**
	 * Shallowest depth at which the member scan ran; unset when every reach
	 * was past the cap. Only computed records run the reviewer ladder — a
	 * list that could never be scanned retains rather than guessing at
	 * reviewers it was never allowed to enumerate.
	 */
	computedDepth?: number;
};

type ExpansionState = {
	skipped: SkippedListMember[];
	skippedKeys: Set<string>;
	/** listId -> computed expansions by restriction, each carrying its compute depth. */
	expansions: Map<string, { full?: CachedExpansion; restricted?: CachedExpansion }>;
	/** The DFS stack — pure cycle detection; it owns no delivery state. */
	computing: Set<string>;
	/** listId -> the nested hold's handling record. */
	held: Map<string, HeldRecord>;
	/** Held lists currently computing — the innermost one owns new dep edges. */
	heldStack: string[];
	senderMailbox: ResolvedMailbox | null;
};

/**
 * Resolves a mailing list into the member mailboxes that get a stored copy.
 * Each member email goes through the same inbound resolution a direct envelope
 * recipient would, so aliases, catch-alls and block rules behave identically.
 * The result is deduplicated by mailbox: two member rows that resolve to the
 * same mailbox (say, an address and its alias) deliver exactly one copy.
 *
 * `ownersOnly` marks the whole delivery as held for review: expansion is
 * restricted to owner members, the reviewers. A nested list that would hold
 * the sender's post itself is a held branch — nothing about it is decided
 * during traversal, so no reach order can displace its reviewers or
 * manufacture a fallback: its record just accumulates direct entries and
 * reviewer-source edges, and the complete no-reviewer handling (sole-
 * reviewer suppression protection, owning-user fallback, `retained`) runs
 * in one settlement pass at the end.
 *
 * The delivery set is a union over expansion branches, and traversal order
 * cannot change it: expansions are cached as results, not visited flags, so
 * a member reached only through a restricted branch is restricted while the
 * same member reached through an unheld sibling branch still receives the
 * post, a shallow reach recomputes what a deep one truncated at the cap,
 * and held records fold their dependency closure once, at the end. Skipped
 * members are reported, never subtracted — which branch a mailbox came
 * through cannot make another branch's copy undeliverable.
 */
export async function expandMailingListDeliveries(
	db: AppDatabase,
	list: ResolvedList,
	envelopeFrom?: string | null,
	options: { ownersOnly?: boolean } = {},
): Promise<MailingListExpansion> {
	const ownersOnly = options.ownersOnly ?? false;
	const state: ExpansionState = {
		skipped: [],
		skippedKeys: new Set(),
		expansions: new Map(),
		computing: new Set(),
		held: new Map(),
		heldStack: [],
		senderMailbox: await resolveMailboxIdentity(db, envelopeFrom ?? ""),
	};
	const root = await expandList(db, list.listId, envelopeFrom, state, ownersOnly ? "restricted" : "full", 0);

	// Expansion entries are all ordinary deliveries — held members never
	// merge reviewer copies into expansion maps, so echo suppression can
	// never strip a held branch's reviewer copy by construction.
	const ordinary = new Map<string, MailingListDelivery>();
	for (const entry of root.entries.values()) {
		ordinary.set(entry.delivery.mailbox.mailboxId, entry.delivery);
	}

	// Held branches settle only now, once every reach is known. A record's
	// reviewer set is the union of its own scan and the scans of every held
	// list its member rows designated — the dependency closure, computed by
	// reachability so dependency cycles find the same fixed point a
	// converged expansion would. Each branch then runs its own ladder:
	// suppression that cannot take the last reviewer, the list's owning
	// user as notice-only fallback, retention when even that fails. A
	// record never computed was reached solely past the depth cap and
	// retains without the ladder — it was never allowed to enumerate its
	// reviewers, so it must not guess.
	const reviewer = new Map<string, MailingListDelivery>();
	const retained = new Map<string, ResolvedList>();
	const folded = new Map<string, Map<string, CachedDelivery>>();
	for (const listId of state.held.keys()) {
		const reviewers = new Map<string, CachedDelivery>();
		const seen = new Set<string>();
		const queue = [listId];
		while (queue.length) {
			const current = queue.pop()!;
			if (seen.has(current)) continue;
			seen.add(current);
			const depRecord = state.held.get(current);
			if (!depRecord) continue;
			// Clone: folded copies get `viaHold`, and the flag must not leak
			// back into the source record's direct entries.
			for (const entry of depRecord.entries.values()) {
				mergeDelivery(reviewers, { ...entry, viaHold: current === listId ? entry.viaHold : true });
			}
			for (const dep of depRecord.deps) queue.push(dep);
		}
		folded.set(listId, reviewers);
	}
	for (const [listId, record] of state.held) {
		if (record.computedDepth === undefined) {
			retained.set(listId, record.list);
			continue;
		}
		const reviewers = folded.get(listId)!;
		const senderId = state.senderMailbox?.mailboxId;
		if (senderId && reviewers.size > 1 && !reviewers.get(senderId)?.viaHold) reviewers.delete(senderId);
		if (!reviewers.size) {
			const fallback = await resolveFallbackReviewer(db, record.list);
			if (fallback) {
				reviewers.set(fallback.mailboxId, {
					delivery: { address: `${fallback.localPart}@${fallback.hostname}`, mailbox: fallback },
					viaHold: true,
					ownerReachable: true,
				});
			}
		}
		if (!reviewers.size) {
			retained.set(listId, record.list);
			continue;
		}
		for (const entry of reviewers.values()) reviewer.set(entry.delivery.mailbox.mailboxId, entry.delivery);
	}

	// Sender dedup: a member posting to the list does not get a copy of their
	// own post, whether their member row uses the address they sent from or an
	// alias of the same mailbox. The identity lookup — not the delivery
	// resolver — decides whose mailbox the sender owns, so a catch-all cannot
	// fold an unrelated sender onto a member mailbox and suppress their copy.
	// Suppression touches ordinary deliveries only: a held post's reviewers
	// are the moderation notice, and for a held post it applies only while
	// another reviewer remains — echo-free delivery must not leave a held
	// post with nobody who can act on it.
	if (state.senderMailbox && (!ownersOnly || ordinary.size + reviewer.size > 1)) {
		ordinary.delete(state.senderMailbox.mailboxId);
	}

	if (ownersOnly && !ordinary.size && !reviewer.size) {
		// A held post must land with a reviewer: when no owner member resolves,
		// the list's owning user's mailbox is the reviewer of last resort.
		const fallback = await resolveFallbackReviewer(db, list);
		if (fallback) {
			reviewer.set(fallback.mailboxId, { address: `${fallback.localPart}@${fallback.hostname}`, mailbox: fallback });
		} else {
			retained.set(list.listId, list);
		}
	}

	// A mailbox reachable both ways keeps the ordinary subscription copy.
	const deliveries = new Map(ordinary);
	for (const [mailboxId, delivery] of reviewer) {
		if (!deliveries.has(mailboxId)) deliveries.set(mailboxId, delivery);
	}
	return { deliveries: [...deliveries.values()], skipped: state.skipped, retained: [...retained.values()] };
}

/**
 * The reviewer of last resort for a held post: the list's owning user's
 * mailbox, preferring one on the list's domain but accepting any of their
 * mailboxes — the point is only that a held copy reaches someone who can act
 * on it. This is a notice destination, not a reviewer identity: the fallback
 * mailbox need not be a member of the list at all, so its owner seeing the
 * held copy does not by itself provide an approve path — approval still takes
 * an unmoderated owner reposting, or an operator acting on a `held/` object.
 * Returns null when the owning user has no enabled mailbox at all; the caller
 * then retains the raw object instead of delivering.
 */
async function resolveFallbackReviewer(
	db: AppDatabase,
	list: ResolvedList,
): Promise<ResolvedMailbox | null> {
	const rows = await db
		.select({ mailbox: mailboxes, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(eq(mailboxes.userId, list.userId), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt));
	const pick = rows.find((row) => row.mailbox.domainId === list.domainId) ?? rows[0];
	if (!pick) return null;
	return {
		mailboxId: pick.mailbox.id,
		folderId: null,
		userId: pick.mailbox.userId,
		domainId: pick.mailbox.domainId,
		localPart: pick.mailbox.localPart,
		hostname: pick.hostname,
		displayName: pick.mailbox.displayName,
	};
}

function pushSkipped(state: ExpansionState, email: string, reason: SkippedListMember["reason"]): void {
	const key = `${reason}${email}`;
	if (state.skippedKeys.has(key)) return;
	state.skippedKeys.add(key);
	state.skipped.push({ email, reason });
}

function mergeDelivery(entries: Map<string, CachedDelivery>, candidate: CachedDelivery): void {
	const existing = entries.get(candidate.delivery.mailbox.mailboxId);
	if (!existing) {
		entries.set(candidate.delivery.mailbox.mailboxId, candidate);
		return;
	}
	// Flags are OR-ed so a mailbox reachable both ways keeps the stronger
	// claims — a reviewer copy stays protected, an owner path stays countable.
	existing.viaHold ||= candidate.viaHold;
	existing.ownerReachable ||= candidate.ownerReachable;
}

/**
 * Records and drives the compute for a nested list that holds the post —
 * deliberately decision-free, so no reach can commit a fallback or
 * retention from incomplete information. Two things happen here: the child
 * is registered as a reviewer source of the held list currently computing
 * (a dependency edge that survives even when this particular reach cannot
 * expand), and the child's restricted member scan runs when this reach has
 * enough remaining depth, unioning what it finds into the record. Returns
 * an outcome only so the caller can report an over-depth member; the actual
 * reviewer set is settled after traversal, in `expandMailingListDeliveries`.
 */
async function reachHeld(
	db: AppDatabase,
	child: ResolvedList,
	envelopeFrom: string | null | undefined,
	state: ExpansionState,
	depth: number,
): Promise<"computed" | "cached" | "cycle" | "too-deep"> {
	const record: HeldRecord = state.held.get(child.listId) ?? {
		list: child,
		entries: new Map(),
		deps: new Set<string>(),
	};
	state.held.set(child.listId, record);
	const enclosing = state.heldStack.at(-1);
	if (enclosing !== undefined) state.held.get(enclosing)!.deps.add(child.listId);
	if (state.computing.has(child.listId)) return "cycle";
	if (record.computedDepth !== undefined && record.computedDepth <= depth) return "cached";
	if (depth >= MAX_LIST_EXPANSION_DEPTH) return "too-deep";
	state.heldStack.push(child.listId);
	try {
		const { entries } = await expandList(db, child.listId, envelopeFrom, state, "restricted", depth);
		for (const entry of entries.values()) mergeDelivery(record.entries, { ...entry });
		record.computedDepth = record.computedDepth === undefined ? depth : Math.min(record.computedDepth, depth);
		return "computed";
	} finally {
		state.heldStack.pop();
	}
}

/**
 * Computes (or reuses) a list's member expansion at one restriction level.
 * Caching stores the result, not a visited flag: a full pass answers a
 * restricted query for free through `ownerReachable`, a cached entry serves
 * any query at equal or greater depth, and a shallower query recomputes for
 * the richer result — the cache converges to the union of every path. A list
 * on the current DFS stack contributes nothing to the caller (its ancestor
 * scan already owns it), past the depth cap a member list resolves only
 * from cache, and a member that holds the post contributes nothing at all —
 * held branches settle from their own records after traversal.
 */
async function expandList(
	db: AppDatabase,
	listId: string,
	envelopeFrom: string | null | undefined,
	state: ExpansionState,
	restriction: ExpansionRestriction,
	depth: number,
): Promise<{ entries: Map<string, CachedDelivery>; blocked: "cycle" | "depth" | null }> {
	const record = state.expansions.get(listId) ?? {};
	state.expansions.set(listId, record);
	const cached = record[restriction];
	if (cached && cached.depth <= depth) return { entries: cached.entries, blocked: null };
	if (restriction === "restricted" && record.full && record.full.depth <= depth) {
		const derived = new Map<string, CachedDelivery>();
		for (const entry of record.full.entries.values()) {
			if (entry.ownerReachable) derived.set(entry.delivery.mailbox.mailboxId, { ...entry });
		}
		record.restricted = { depth: record.full.depth, entries: derived };
		return { entries: derived, blocked: null };
	}
	if (state.computing.has(listId)) return { entries: new Map(), blocked: "cycle" };
	if (depth >= MAX_LIST_EXPANSION_DEPTH) return { entries: new Map(), blocked: "depth" };

	state.computing.add(listId);
	try {
		const entries = new Map<string, CachedDelivery>();
		const members = await db
			.select({ email: mailingListMembers.email, role: mailingListMembers.role })
			.from(mailingListMembers)
			.where(and(eq(mailingListMembers.listId, listId), ...(restriction === "restricted" ? [eq(mailingListMembers.role, "owner")] : [])));

		for (const member of members) {
			const decision = await resolveInboundAddress(db, member.email, envelopeFrom);
			if (decision?.mailbox) {
				mergeDelivery(entries, {
					delivery: { address: normalizeEmailAddress(member.email), mailbox: decision.mailbox },
					viaHold: false,
					ownerReachable: member.role === "owner",
				});
				continue;
			}
			if (decision?.action === "list" && decision.list) {
				const child = decision.list;
				if (decision.heldForModeration) {
					// A list that would itself hold this post is a held branch.
					// Its reviewers are settled globally after traversal — nothing
					// merges into this expansion — so a reach here only records
					// the dependency and drives the child's own compute.
					const outcome = await reachHeld(db, child, envelopeFrom, state, depth + 1);
					if (outcome === "too-deep") pushSkipped(state, member.email, "too-deep");
					continue;
				}
				const childResult = await expandList(db, child.listId, envelopeFrom, state, restriction, depth + 1);
				if (childResult.blocked) {
					pushSkipped(state, member.email, childResult.blocked === "cycle" ? "already-expanded" : "too-deep");
					continue;
				}
				for (const entry of childResult.entries.values()) {
					mergeDelivery(entries, {
						delivery: entry.delivery,
						viaHold: entry.viaHold,
						ownerReachable: member.role === "owner" && entry.ownerReachable,
					});
				}
				continue;
			}
			pushSkipped(state, member.email, decision?.action === "reject" ? "rejected" : "external");
		}
		record[restriction] = { depth, entries };
		return { entries, blocked: null };
	} finally {
		state.computing.delete(listId);
	}
}

/**
 * Fans a list-addressed inbound message out to every resolved member mailbox.
 * Each member gets their own copy of the raw MIME under their mailbox-scoped
 * storage key, so the queue's `(mailboxId, rawR2Key)` dedup keeps queue retries
 * idempotent, a direct copy of the same message dedupes the member's list copy,
 * and one member deleting their copy cannot drop the object under the others.
 *
 * Which list an envelope recipient names is decided in resolveInboundAddress:
 * exact tagged list > enabled alias paths > base list. A stored `team+x`
 * claims `team+x@domain` ahead of the enabled `team` mailbox and alias
 * claims; `team+x` falls back to the `team` list only when no `team+x` list
 * exists. An empty-tag `team+@domain` is literal-only for lists — only a
 * stored `team+` claims it, never the `team` base — matching how the
 * plus-addressing pass treats empty tags; a tag that itself ends in `+`
 * (`team++`, `team+x+`) is non-empty and falls back to `team` normally. On
 * this base the mailbox claims
 * still strip `+` to base, so `team+` mail lands in the `team` mailbox when
 * no `team+` claimant exists; the divergence disappears once #416 merges.
 *
 * A member copy carries the member's own subscribed address as its envelope
 * recipient (`payload.to` = member address), never the list's — a member
 * subscribed as `bob+lists@domain` re-resolves and stores under
 * `bob+lists@domain`, so member-side tag rules see the member's own `+lists`
 * tag. A tag on the list address (`team+x`) is list-routing metadata only and
 * never reaches member rules.
 *
 * External members (an address no hosted domain resolves) are skipped, not
 * forwarded: the outbound queue only sends from user-owned mailbox identities,
 * and correct off-instance list forwarding (envelope sender rewriting, posting
 * rules) belongs to a later slice.
 *
 * A member failure does not lose the sibling deliveries: every member is
 * attempted, then the first error is rethrown so the queue retry replays the
 * payload — already-stored members are skipped by the storage-key dedup.
 *
 * A post the routing decision held for review (`ownersOnly`) goes only to the
 * list's owner members — the reviewers — instead of the full membership. The
 * reviewer copy is the moderation notice: an owner approves by reposting the
 * message to the list, which a list-level `moderated` flag does not re-hold
 * because owner senders are exempt from it. A member-level `moderated` flag
 * is honored at every role, so a moderated owner's repost is re-held for the
 * remaining owners — approve-via-repost needs at least one unmoderated owner.
 * A list that moderates every owner row still delivers the reviewer copies;
 * it just has no built-in approval path — every repost re-holds, so clearing
 * the hold takes an operator acting on a delivered copy or unflagging a row.
 *
 * Every held branch — the root list or a nested list that holds the post —
 * gets a reviewer: its owner members, then its owning user's mailbox as a
 * notice-only destination, then retention under `held/<listId>/<hash>.eml`.
 * Retained objects sit outside the `inbound/` sweep and are operator-
 * recoverable from the bucket only — no in-app replay exists yet, and
 * bounded retention plus operator alerting are deferred to the
 * approve/discard-queue slice. A list with no reachable reviewer
 * accepts-and-holds rather than bouncing: an SMTP-level reject is only
 * available while the message is still being received, and by fan-out time
 * the choice is keep-or-drop — a recoverable `held/` copy beats silently
 * dropping a post the list owner may still want. A real pending-posts
 * queue is a later slice.
 */
export async function deliverToMailingList(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	list: ResolvedList,
	deliver: (payload: InboundQueueMessage, mailbox: ResolvedMailbox) => Promise<void>,
	options: { ownersOnly?: boolean } = {},
): Promise<void> {
	const db = getDb(env);
	const { deliveries, skipped, retained } = await expandMailingListDeliveries(db, list, payload.from, options);
	if (options.ownersOnly) {
		console.info(`Mailing list ${list.localPart}@${list.hostname}: post from ${payload.from} held for owner review`);
	}
	if (skipped.length) {
		console.info(`Mailing list ${list.localPart}@${list.hostname}: skipped ${skipped.map((member) => `${member.email} (${member.reason})`).join(", ")}`);
	}
	if (!deliveries.length && !retained.length) {
		console.warn(`Mailing list ${list.localPart}@${list.hostname} has no deliverable members`);
		await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		return;
	}

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}
	const buffer = await raw.arrayBuffer();

	// A held branch with no reviewer must never vanish silently: retain the
	// raw under a content-keyed `held/` object per holding list (retries
	// idempotent) where ops or a later moderation surface can recover it.
	for (const heldList of retained) {
		const heldKey = await heldInboundKey(heldList.listId, buffer);
		await env.BUCKET.put(heldKey, buffer, {
			httpMetadata: { contentType: "message/rfc822" },
			customMetadata: { from: payload.from, to: payload.to },
		});
		console.warn(`Mailing list ${heldList.localPart}@${heldList.hostname}: held post retained at ${heldKey} — no reviewer could receive it`);
	}
	if (!deliveries.length) {
		await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		return;
	}

	let firstError: unknown = null;
	for (const delivery of deliveries) {
		const rawR2Key = await inboundStorageKey(buffer, mailboxInboundScope(delivery.mailbox.mailboxId));
		await env.BUCKET.put(rawR2Key, buffer, {
			httpMetadata: { contentType: "message/rfc822" },
			customMetadata: { from: payload.from, to: delivery.address },
		});
		try {
			await deliver({ ...payload, to: delivery.address, rawR2Key }, delivery.mailbox);
		} catch (error) {
			console.error(`Mailing list delivery to ${delivery.address} failed`, error);
			firstError ??= error;
		}
	}
	// Keep the source object while any member still needs the retry; once every
	// member's own copy is stored the original is unreferenced.
	if (firstError) throw firstError;
	await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
}
