import { parseAddress } from "@/lib/utils";
import type { ParsedRecipientAddress } from "./recipient-address-types";

/**
 * Dot- and case-normalized local part with any `+tag` kept: `U.Ser+Tag` becomes
 * `user+tag`. Delivery tries this form first so a literal `user+tag` mailbox or
 * list beats the `user` base address.
 */
export function normalizeRecipientFullLocalPart(localPart: string): string {
	return localPart
		.replaceAll(".", "")
		.toLowerCase();
}

export function normalizeRecipientLocalPart(localPart: string): string {
	const [baseLocalPart] = localPart.split("+", 1);
	return baseLocalPart
		.replaceAll(".", "")
		.toLowerCase();
}

export function parseRecipientAddress(address: string): ParsedRecipientAddress | null {
	const parsed = parseAddress(address);
	if (!parsed) return null;

	const localPart = normalizeRecipientLocalPart(parsed.local);
	if (!localPart) return null;

	const fullLocalPart = normalizeRecipientFullLocalPart(parsed.local);
	// The subaddress splits at the first "+". An empty tag (`user+@…`) does not
	// split for routing: `hasSubaddress` is false and `fullLocalPart` keeps the
	// literal `user+`, which claimants that honor literal-only empty tags (the
	// mailing-list lookups) detect as `!hasSubaddress && endsWith("+")` — a tag
	// of "+" alone, like `user++`, is non-empty and subaddresses normally.
	const separator = fullLocalPart.indexOf("+");

	return {
		original: address,
		localPart,
		fullLocalPart,
		hasSubaddress: separator > -1 && separator < fullLocalPart.length - 1,
		domain: parsed.domain,
		normalizedAddress: `${localPart}@${parsed.domain}`,
	};
}
