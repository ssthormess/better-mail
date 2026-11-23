export type ParsedRecipientAddress = {
	original: string;
	localPart: string;
	/** The normalized local part with any `+tag` kept. */
	fullLocalPart: string;
	/** True when the address carries a non-empty `+tag`. */
	hasSubaddress: boolean;
	domain: string;
	normalizedAddress: string;
};
