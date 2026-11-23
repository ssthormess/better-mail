import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxAliases, mailboxes, mailingListMembers, mailingLists } from "@/db/schema";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import {
	normalizeRecipientFullLocalPart,
	normalizeRecipientLocalPart,
	parseRecipientAddress,
} from "@/lib/email/recipient-address";
import type { SessionUser } from "@/lib/auth/types";

/**
 * The list a caller may manage: only its owning user (list.userId) can, so a
 * non-owner gets the same null — and the same 404 — as a missing row. Domains
 * are joined because every route response and Cloudflare call needs the
 * hostname, zone id and receiving provider.
 */
export async function getOwnedList(db: AppDatabase, user: Pick<SessionUser, "id">, id: string) {
	const [row] = await db
		.select({ list: mailingLists, domain: domains })
		.from(mailingLists)
		.innerJoin(domains, eq(mailingLists.domainId, domains.id))
		.where(and(eq(mailingLists.id, id), eq(mailingLists.userId, user.id)))
		.limit(1);
	return row ?? null;
}

export function listResponse(list: typeof mailingLists.$inferSelect, hostname: string) {
	return { ...list, hostname, address: `${list.localPart}@${hostname}` };
}

export function listMembers(db: AppDatabase, listId: string) {
	return db
		.select()
		.from(mailingListMembers)
		.where(eq(mailingListMembers.listId, listId))
		.orderBy(asc(mailingListMembers.createdAt), asc(mailingListMembers.id));
}

/**
 * The domain an address-creating call may use: the caller's own, or their
 * account creator's when they hold the mailbox-management grant — the same
 * scope mailbox creation applies. A list is a new address, so it additionally
 * requires an active domain, like alias creation.
 */
export function canUseDomainForAddresses(user: Pick<SessionUser, "id" | "canManageMailboxes" | "createdByUserId">, domain: Pick<typeof domains.$inferSelect, "userId" | "status">) {
	if (domain.status !== "active") return false;
	return domain.userId === user.id
		|| (user.canManageMailboxes && !!user.createdByUserId && domain.userId === user.createdByUserId);
}

/**
 * A use-all-domains mailbox that resolves `address` as one of its own. Creating
 * a list on that address would silently take the mailbox's mail — the same
 * shadow alias creation refuses. Only the mailbox's own local part can produce
 * the address (its aliases live on their own domains and are checked there).
 */
async function findAllDomainsMailboxClaiming(db: AppDatabase, address: string) {
	const target = parseRecipientAddress(address);
	if (!target) return null;
	const candidates = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
		.from(mailboxes)
		.where(eq(mailboxes.useAllDomains, true));
	for (const candidate of candidates) {
		if (normalizeRecipientLocalPart(candidate.localPart) !== target.localPart) continue;
		const addresses = await getMailboxDomainAddresses(db, candidate);
		if (addresses.some((item) => parseRecipientAddress(item)?.normalizedAddress === target.normalizedAddress)) return candidate;
	}
	return null;
}

/**
 * Routing resolves a recipient by normalized local part, so a new list address
 * must conflict-check the same way. Mailboxes and aliases compare with the tag
 * stripped — `team+x` collides with `team` because the literal-list claim would
 * take `team+x` mail those claimants own. Lists compare with the tag kept:
 * `team+x` and `team` are distinct claims that may coexist by design.
 *
 * The reverse direction is not yet enforced: mailbox and alias creation do not
 * check lists, so one can still be created over a list and shadow it (F07
 * finding — those routes are outside this slice). Deletion compensates: see
 * listAddressStillClaimed.
 */
export async function findListAddressConflict(
	db: AppDatabase,
	domain: Pick<typeof domains.$inferSelect, "id" | "hostname">,
	localPart: string,
): Promise<"mailbox" | "alias" | "list" | null> {
	const [domainMailboxes, domainAliases, domainLists] = await Promise.all([
		db.select({ localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, domain.id)),
		db.select({ localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domain.id)),
		db.select({ localPart: mailingLists.localPart }).from(mailingLists).where(eq(mailingLists.domainId, domain.id)),
	]);
	const base = normalizeRecipientLocalPart(localPart);
	const full = normalizeRecipientFullLocalPart(localPart);
	if (domainMailboxes.some((row) => normalizeRecipientLocalPart(row.localPart) === base)) return "mailbox";
	if (domainAliases.some((row) => normalizeRecipientLocalPart(row.localPart) === base)) return "alias";
	if (domainLists.some((row) => normalizeRecipientFullLocalPart(row.localPart) === full)) return "list";
	if (await findAllDomainsMailboxClaiming(db, `${localPart}@${domain.hostname}`)) return "mailbox";
	return null;
}

/**
 * Whether anything still resolves `localPart@hostname` once this list is gone,
 * in which case its Cloudflare rule must stay. Because mailbox and alias
 * creation do not check lists yet, one may now own the address. Another list
 * can also inherit a tagged address's fallback — a `team` list claims `team+x`
 * once the literal list is gone — but never a literal-only `team+`.
 */
export async function listAddressStillClaimed(
	db: AppDatabase,
	domain: Pick<typeof domains.$inferSelect, "id" | "hostname">,
	list: Pick<typeof mailingLists.$inferSelect, "id" | "localPart">,
): Promise<boolean> {
	const base = normalizeRecipientLocalPart(list.localPart);
	const full = normalizeRecipientFullLocalPart(list.localPart);
	const fallbackKey = full !== base && !full.endsWith("+") ? base : null;
	const [domainMailboxes, domainAliases, domainLists] = await Promise.all([
		db.select({ localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, domain.id)),
		db.select({ localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domain.id)),
		db.select({ id: mailingLists.id, localPart: mailingLists.localPart }).from(mailingLists).where(eq(mailingLists.domainId, domain.id)),
	]);
	if (domainMailboxes.some((row) => normalizeRecipientLocalPart(row.localPart) === base)) return true;
	if (domainAliases.some((row) => normalizeRecipientLocalPart(row.localPart) === base)) return true;
	if (domainLists.some((row) =>
		row.id !== list.id
		&& (normalizeRecipientFullLocalPart(row.localPart) === full
			|| (fallbackKey !== null && normalizeRecipientFullLocalPart(row.localPart) === fallbackKey)))) return true;
	return !!(await findAllDomainsMailboxClaiming(db, `${list.localPart}@${domain.hostname}`));
}
