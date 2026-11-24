import { and, asc, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, mailboxes, mailingListMembers } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { deleteUnreferencedRawMail, heldInboundKey, inboundStorageKey, mailboxInboundScope } from "@/lib/email/inbound-id";
import { resolveInboundAddress, resolveMailboxIdentity, type ResolvedList, type ResolvedMailbox } from "@/lib/email/routing";
import type { InboundQueueMessage } from "@/lib/email/inbound";

/**
 * Nested list expansion is a state machine over self-contained branch
 * results, not a merged accumulator. A member scan produces one record —
 * direct member-mailbox deliveries plus first-class edges to member rows
 * naming other lists, each edge carrying the moderation verdict that row
 * decided — and every verdict consumers need (delivery sets, dependency
 * edges, hold records) is folded from those records in a settlement pass
 * once traversal ends. Traversal bookkeeping — the DFS stack, reach
 * order, the cache itself — never enters a result, so no reach order can
 * change the outcome:
 *
 * - Results are the only state that outlives a reach. A cached result
 *   replays the same edges a fresh compute recorded, so a hit behaves
 *   identically to a compute; a shallower reach re-traverses edges a
 *   deeper one capped.
 * - A member edge exists the moment the parent's scan classifies the
 *   row. A child the traversal never reaches still has its edge — a
 *   cycle- or depth-truncated branch records INCOMPLETE rather than
 *   masquerading as a verified empty one.
 * - A held verdict registers a held record: the hold is a graph node
 *   carrying its holding list, the dependency edges that designated it
 *   and its folded reviewer set. No fallback, suppression or retention
 *   is decided while a dependent branch's verdict can still change —
 *   the fold runs after every scan is final, so children settle before
 *   their parents' ladders.
 *
 * The depth cap bounds the member queries a pathological chain can cost
 * in one inbound delivery, and the DFS stack remains the cycle guard.
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
	 * False when traversal truncated a member edge — the cycle guard or
	 * the depth cap — anywhere in the expansion graph, so the delivery
	 * set may be missing members a scan never enumerated. Folded from
	 * the branch results after traversal, so it reflects every edge's
	 * final outcome rather than the order branches were reached in.
	 */
	complete: boolean;
	/**
	 * Held roots whose hold produced no deliverable reviewer — neither an
	 * owner member nor the list's owning user — anywhere in the expansion
	 * graph. The caller retains the raw object under `held/<listId>/` for
	 * each, so a held post is never silently discarded no matter how
	 * deeply the holding list is nested.
	 */
	retained: ResolvedList[];
};

/**
 * The member-row filter a branch scan ran under. "full" enumerates every
 * member row — the ordinary delivery expansion. "restricted" enumerates
 * owner-role rows only — the reviewer expansion a held post fans out to.
 * The addressed list takes "restricted" exactly when the post is held;
 * every other branch inherits its parent's restriction, except a held
 * edge, which always scans its child restricted.
 */
type ExpansionRestriction = "restricted" | "full";

/**
 * One resolved member mailbox inside a branch result. `ownerReachable` is
 * what lets a full result answer a restricted query: a restricted scan of
 * the same member rows produces exactly the entries flagged here, so the
 * restricted view of a full result is a projection, not a second compute.
 */
type CachedDelivery = {
	delivery: MailingListDelivery;
	ownerReachable: boolean;
};

/**
 * A member row that names another list — a first-class dependency edge in
 * the expansion graph. The scan records everything the row decided:
 * `held` is the moderation verdict the child's own posting check returned
 * for this sender (a list that would hold the post is a held root, never
 * an ordinary expansion), and `ownerRow` keeps the row's role so the
 * restricted view can project owner edges. `blocked` is the last
 * traversal outcome — bookkeeping, not verdict: the edge itself was fully
 * classified when the parent's member scan ran, so a child the traversal
 * could not reach is still part of the record rather than a silent gap.
 */
type MemberEdge = {
	list: ResolvedList;
	held: boolean;
	ownerRow: boolean;
	/** The member row that created this edge, kept for skip reporting. */
	memberEmail: string;
	blocked: "cycle" | "depth" | null;
	/**
	 * The child result this edge's last traversal consumed — null while
	 * the edge is untraversed or was blocked. The settlement pass judges
	 * a result on the completeness of what it actually folded, so the
	 * record keeps the consumed object, not a recomputed lookup.
	 */
	result: BranchResult | null;
};

/**
 * One list's expansion verdict under one restriction — a self-contained
 * record. `entries` are this branch's own member-mailbox deliveries,
 * `edges` its member rows naming other lists; a result never contains a
 * child's entries, so no child's truncation can masquerade as content
 * here. `depth` is provenance — the shallowest depth this result's edges
 * were traversed at — so a deeper-computed result re-traverses when a
 * shallower reach can go further. `complete` flags truncation: false when
 * a member edge's traversal was cut by the cycle guard or the depth cap
 * on the last traversal, or when a child result it consumed settled
 * incomplete — an incomplete branch folded upward reads identically to a
 * truncated one. `projected` marks a restricted view derived from the
 * full result rather than a member scan of its own.
 */
type BranchResult = {
	listId: string;
	restriction: ExpansionRestriction;
	depth: number;
	complete: boolean;
	projected: boolean;
	entries: Map<string, CachedDelivery>;
	edges: Map<string, MemberEdge>;
};

/**
 * A list that holds this post — a first-class node in the expansion
 * graph, created when a member scan classifies a row as a held edge (and
 * for the addressed list itself when the post is held). The record owns
 * the holding list's identity and is settled in the post-traversal fold:
 * `deps` materializes the held lists reachable from it over owner-role
 * edges and `reviewers` the folded reviewer set. Nothing about the hold
 * is decided mid-traversal, so an over-depth reach or an in-progress
 * cycle cannot manufacture a fallback beside a real reviewer.
 */
type HeldRecord = {
	list: ResolvedList;
	deps: Set<string>;
	reviewers: Map<string, CachedDelivery>;
};

type ExpansionState = {
	skipped: SkippedListMember[];
	skippedKeys: Set<string>;
	/**
	 * listId -> branch results by restriction — the traversal cache. What
	 * is cached is the result record, not a visited flag: every entry the
	 * settlement fold reads lives inside one of these.
	 */
	results: Map<string, { full?: BranchResult; restricted?: BranchResult }>;
	/** The DFS stack — pure cycle detection; it owns no delivery state. */
	computing: Set<string>;
	/** listId -> held root — the graph of holds discovered while scanning. */
	held: Map<string, HeldRecord>;
	senderMailbox: ResolvedMailbox | null;
};

/**
 * Resolves a mailing list into the member mailboxes that get a stored copy.
 * Each member email goes through the same inbound resolution a direct
 * envelope recipient would, so aliases, catch-alls and block rules behave
 * identically — including each nested list's own posting check, which is
 * what makes a nested `members_only` list deny a non-member sender on its
 * branch and a nested moderated list hold it. The result is deduplicated
 * by mailbox: two member rows that resolve to the same mailbox (say, an
 * address and its alias) deliver exactly one copy.
 *
 * `ownersOnly` marks the whole delivery as held for review: the root scan
 * is restricted to owner members, the reviewers. The same machinery
 * applies per branch — a member row that names a list holding this post
 * is a held edge, and its child expands restricted, producing a reviewer
 * set rather than ordinary deliveries. A member reachable both through a
 * held branch and an unheld one still gets its ordinary copy: branches
 * are results, not visited flags, so neither reach order can consume the
 * other.
 *
 * The delivery set is a union over branch results, and the reviewer sets
 * are a fold over the owner-edge graph — both computed in one settlement
 * pass after traversal, so traversal order cannot change them. Skipped
 * members are reported, never subtracted: which branch a mailbox came
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
		results: new Map(),
		computing: new Set(),
		held: new Map(),
		senderMailbox: await resolveMailboxIdentity(db, envelopeFrom ?? ""),
	};
	// A held root is a held record like any nested one — registered before
	// its scan so a descendant edge that points back at it folds the real
	// record instead of finding none.
	if (ownersOnly) ensureHeld(state, list);
	const root = await expandList(db, list.listId, envelopeFrom, state, ownersOnly ? "restricted" : "full", 0);

	// Completeness settles like every other verdict — after traversal, not
	// mid-reach. A result is complete only when no edge was blocked and
	// every child result its edges consumed settled complete itself; flags
	// only downgrade, so the sweep converges. A cached hit on an incomplete
	// result then answers flagged-incomplete rather than masquerading as a
	// fully verified expansion.
	let settling = true;
	while (settling) {
		settling = false;
		for (const slots of state.results.values()) {
			for (const result of [slots.full, slots.restricted]) {
				if (!result?.complete) continue;
				for (const edge of result.edges.values()) {
					if (edge.blocked || edge.result?.complete === false) {
						result.complete = false;
						settling = true;
						break;
					}
				}
			}
		}
	}

	// Ordinary deliveries are the union of every full branch's own entries:
	// a list contributes its members to the fan-out exactly when an unheld
	// path scanned it, and each branch contributes only its own member
	// rows — a child's entries always arrive through the child's own
	// result. Restricted branches feed only reviewer sets.
	const ordinary = new Map<string, MailingListDelivery>();
	for (const slots of state.results.values()) {
		if (!slots.full) continue;
		for (const entry of slots.full.entries.values()) {
			ordinary.set(entry.delivery.mailbox.mailboxId, entry.delivery);
		}
	}

	// Every held record settles now, once all verdicts are final — the
	// ordering guarantee the whole design exists for. A record's reviewer
	// set is the fold of its owner-edge closure: its own restricted
	// entries plus the restricted entries of every list reachable over
	// owner-role edges, held or not, so a held child contributes its
	// reviewers to every held parent that designated it. A record never
	// scanned — reached only past the depth cap — retains rather than
	// guessing at reviewers it was never allowed to enumerate.
	const reviewer = new Map<string, MailingListDelivery>();
	const retained = new Map<string, ResolvedList>();
	for (const [listId, record] of state.held) {
		const ownView = restrictedView(state, listId);
		if (!ownView) {
			retained.set(listId, record.list);
			continue;
		}
		const reviewers = new Map<string, CachedDelivery>();
		const seen = new Set([listId]);
		const queue = [listId];
		while (queue.length) {
			const current = queue.pop()!;
			const view = restrictedView(state, current);
			if (!view) continue;
			for (const entry of view.entries.values()) mergeDelivery(reviewers, entry);
			for (const edge of view.edges.values()) {
				const childId = edge.list.listId;
				if (seen.has(childId)) continue;
				seen.add(childId);
				if (state.held.has(childId)) record.deps.add(childId);
				queue.push(childId);
			}
		}
		record.reviewers = reviewers;

		// Echo suppression inside a hold is scoped to the sender's own
		// reviewer rows on this branch: a copy that only arrives through a
		// held dependent is that dependent's moderation notice — stripping
		// it here would strip the wrong record's notice. And it never takes
		// the last reviewer: the moderation notice must reach someone.
		const senderId = state.senderMailbox?.mailboxId;
		if (senderId && reviewers.size > 1 && ownView.entries.has(senderId)) {
			reviewers.delete(senderId);
		}
		// The reviewer ladder only now: owner members settled above, then
		// the list's owning user as a notice-only destination, then
		// retention under `held/<listId>/`. Running it before the closure
		// would let an unsettled dependency hide a real reviewer.
		if (!reviewers.size) {
			const fallback = await resolveFallbackReviewer(db, record.list);
			if (fallback) {
				reviewers.set(fallback.mailboxId, {
					delivery: { address: `${fallback.localPart}@${fallback.hostname}`, mailbox: fallback },
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

	// Sender dedup: a member posting to the list does not get a copy of
	// their own post, whether their member row uses the address they sent
	// from or an alias of the same mailbox. The identity lookup — not the
	// delivery resolver — decides whose mailbox the sender owns, so a
	// catch-all cannot fold an unrelated sender onto a member mailbox and
	// suppress their copy. For a held root every copy is a moderation
	// notice already, so the guard only has to keep echo suppression from
	// emptying the whole delivery set.
	if (state.senderMailbox && (!ownersOnly || ordinary.size + reviewer.size > 1)) {
		ordinary.delete(state.senderMailbox.mailboxId);
	}

	// A mailbox reachable both ways keeps the ordinary subscription copy.
	const deliveries = new Map(ordinary);
	for (const [mailboxId, delivery] of reviewer) {
		if (!deliveries.has(mailboxId)) deliveries.set(mailboxId, delivery);
	}
	return {
		deliveries: [...deliveries.values()],
		skipped: state.skipped,
		retained: [...retained.values()],
		complete: root.result?.complete ?? false,
	};
}

/**
 * The restricted view of a branch — its owner-role members and owner-role
 * edges. A real restricted result is used as-is; a list scanned only full
 * answers through projection, since owner rows are all a restricted scan
 * would have seen anyway.
 */
function restrictedView(state: ExpansionState, listId: string): BranchResult | null {
	const slots = state.results.get(listId);
	if (slots?.restricted) return slots.restricted;
	return slots?.full ? projectRestricted(slots.full) : null;
}

/** Derives a list's restricted result from its full one: owner rows only. */
function projectRestricted(full: BranchResult): BranchResult {
	const entries = new Map<string, CachedDelivery>();
	for (const [mailboxId, entry] of full.entries) {
		if (entry.ownerReachable) entries.set(mailboxId, entry);
	}
	const edges = new Map<string, MemberEdge>();
	for (const [listId, edge] of full.edges) {
		if (edge.ownerRow) edges.set(listId, edge);
	}
	return {
		listId: full.listId,
		restriction: "restricted",
		depth: full.depth,
		complete: full.complete && [...edges.values()].every((edge) => !edge.blocked),
		projected: true,
		entries,
		edges,
	};
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
	const key = `${reason} ${email}`;
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
	// Two rows can land on one mailbox; the reach flag is OR-ed so a mailbox
	// reachable as owner through either keeps its restricted visibility.
	existing.ownerReachable ||= candidate.ownerReachable;
}

function ensureHeld(state: ExpansionState, list: ResolvedList): HeldRecord {
	let record = state.held.get(list.listId);
	if (!record) {
		record = { list, deps: new Set(), reviewers: new Map() };
		state.held.set(list.listId, record);
	}
	return record;
}

/**
 * Computes (or reuses) one list's branch result at one restriction, then
 * traverses its edges. The result itself is built once — the member scan
 * is deterministic — and the depth it carries is the shallowest traversal
 * so far: a cached result serves any query at equal or greater depth, a
 * shallower query re-traverses the recorded edges so the frontier a deep
 * reach capped still expands. The stored result answers re-entrant
 * queries mid-traversal (its entries and edges were complete at scan
 * time), so the DFS stack only ever cuts a genuinely uncomputed visit.
 * A held edge scans its child restricted whatever the parent ran; any
 * other edge inherits the parent's restriction.
 */
async function expandList(
	db: AppDatabase,
	listId: string,
	envelopeFrom: string | null | undefined,
	state: ExpansionState,
	restriction: ExpansionRestriction,
	depth: number,
): Promise<{ result: BranchResult | null; blocked: "cycle" | "depth" | null }> {
	const slots = state.results.get(listId) ?? {};
	state.results.set(listId, slots);

	let result = slots[restriction];
	let derived = false;
	if (!result && restriction === "restricted" && slots.full && slots.full.depth <= depth) {
		// A completed full result already answers the restricted query:
		// owner rows are all a restricted scan would see.
		result = slots.restricted = projectRestricted(slots.full);
		derived = true;
	}
	if (result && !derived && result.depth <= depth) return { result, blocked: null };
	if (state.computing.has(listId)) return { result: null, blocked: "cycle" };
	if (depth >= MAX_LIST_EXPANSION_DEPTH) return { result: null, blocked: "depth" };

	state.computing.add(listId);
	try {
		result ??= slots[restriction] = await scanList(db, listId, envelopeFrom, state, restriction, depth);
		result.depth = depth;
		result.complete = true;
		for (const edge of result.edges.values()) {
			const childResult = await expandList(db, edge.list.listId, envelopeFrom, state, edge.held ? "restricted" : restriction, depth + 1);
			edge.blocked = childResult.blocked;
			edge.result = childResult.result;
			// A truncated edge — or a child whose own result settled
			// incomplete — marks the parent incomplete: the record keeps
			// the edge, so the loss is visible rather than a silent
			// "verified no members". A held edge blocked by a live cycle is
			// not a skipped member: its own frame is already expanding it.
			if (childResult.blocked || childResult.result?.complete === false) result.complete = false;
			if (!childResult.blocked) continue;
			if (childResult.blocked === "depth") pushSkipped(state, edge.memberEmail, "too-deep");
			else if (!edge.held) pushSkipped(state, edge.memberEmail, "already-expanded");
		}
		return { result, blocked: null };
	} finally {
		state.computing.delete(listId);
	}
}

/**
 * Runs one list's member query into a fresh branch result: mailbox
 * resolutions become direct entries, list resolutions become edges —
 * each carrying the hold verdict the child's posting check returned —
 * and everything else is reported skipped. A held edge registers the
 * child's held record here, at edge discovery, so a hold exists in the
 * graph even when the child's own scan is never reached within the cap.
 */
async function scanList(
	db: AppDatabase,
	listId: string,
	envelopeFrom: string | null | undefined,
	state: ExpansionState,
	restriction: ExpansionRestriction,
	depth: number,
): Promise<BranchResult> {
	const result: BranchResult = {
		listId,
		restriction,
		depth,
		complete: true,
		projected: false,
		entries: new Map(),
		edges: new Map(),
	};
	const members = await db
		.select({ email: mailingListMembers.email, role: mailingListMembers.role })
		.from(mailingListMembers)
		.where(and(eq(mailingListMembers.listId, listId), ...(restriction === "restricted" ? [eq(mailingListMembers.role, "owner")] : [])));

	for (const member of members) {
		const decision = await resolveInboundAddress(db, member.email, envelopeFrom);
		if (decision?.mailbox) {
			mergeDelivery(result.entries, {
				delivery: { address: normalizeEmailAddress(member.email), mailbox: decision.mailbox },
				ownerReachable: member.role === "owner",
			});
			continue;
		}
		if (decision?.action === "list" && decision.list) {
			const existing = result.edges.get(decision.list.listId);
			if (existing) {
				existing.ownerRow ||= member.role === "owner";
				existing.held ||= !!decision.heldForModeration;
				continue;
			}
			const held = !!decision.heldForModeration;
			result.edges.set(decision.list.listId, {
				list: decision.list,
				held,
				ownerRow: member.role === "owner",
				memberEmail: member.email,
				blocked: null,
				result: null,
			});
			if (held) ensureHeld(state, decision.list);
			continue;
		}
		pushSkipped(state, member.email, decision?.action === "reject" ? "rejected" : "external");
	}
	return result;
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
 * A post the routing decision held for review (`ownersOnly`) goes only to
 * the addressed list's owner members — the reviewers — instead of the full
 * membership, and each nested branch that holds the post does the same on
 * its own reviewer set. The reviewer copy is the moderation notice: an
 * owner approves by reposting the message to the list, which a list-level
 * `moderated` flag does not re-hold because owner senders are exempt from
 * it. A member-level `moderated` flag is honored at every role, so a
 * moderated owner's repost is re-held for the remaining owners —
 * approve-via-repost needs at least one unmoderated owner. A list that
 * moderates every owner row still delivers the reviewer copies; it just
 * has no built-in approval path — every repost re-holds, so clearing the
 * hold takes an operator acting on a delivered copy or unflagging a row.
 *
 * Every held root — the addressed list or a nested list that holds the
 * post — gets a reviewer: its owner members plus the owner members of
 * held lists it depends on, then its owning user's mailbox as a
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
	const { deliveries, skipped, retained, complete } = await expandMailingListDeliveries(db, list, payload.from, options);
	if (options.ownersOnly) {
		console.info(`Mailing list ${list.localPart}@${list.hostname}: post from ${payload.from} held for owner review`);
	}
	if (!complete) {
		console.warn(`Mailing list ${list.localPart}@${list.hostname}: expansion incomplete — some member branches were cut by the cycle guard or depth cap`);
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
