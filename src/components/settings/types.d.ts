export type ProfileFormProps = {
	initialResetEmail: string;
};

export type ProfileFormResponse = {
	user?: {
		name: string;
		timeZone: string | null;
		resetEmail: string | null;
		forwardingEmail: string | null;
		canForwardEmail: boolean;
	};
	error?: unknown;
};

export type AccountSettingsResponse = {
	user?: {
		id: string;
		email: string;
		name: string;
		timeZone: string | null;
		resetEmail: string | null;
		forwardingEmail: string | null;
		canForwardEmail: boolean;
	};
	error?: unknown;
};

export type MfaEnrollmentResponse = {
	secret?: string;
	otpauthUrl?: string;
	qrSvg?: string;
	error?: unknown;
};

export type MfaRecoveryCodesResponse = {
	recoveryCodes?: string[];
	error?: unknown;
};

export type ForwardingEmailFormProps = {
	initialForwardingEmail: string;
};

export type ForwardingEmailResponse = {
	forwardingEmail?: string | null;
	error?: unknown;
};

export type MailboxSignatureResponse = {
	mailbox?: {
		id: string;
		localPart: string;
		hostname: string;
		displayName: string | null;
		signature: string | null;
		hasAvatar?: boolean;
		isPrimary?: boolean;
	};
	error?: unknown;
};

export type MailboxAutoReplySettings = {
	enabled: boolean;
	subject: string;
	body: string;
	/** `datetime-local` wall times in the user's zone; "" means open-ended. */
	startAt: string;
	endAt: string;
};

export type MailboxAutoReplySaved = MailboxAutoReplySettings & {
	/** The stored window instants echoed by the API, for the mailbox provider. */
	autoReplyStartAt: string | null;
	autoReplyEndAt: string | null;
};

export type MailboxAutoReplyResponse = {
	mailbox?: {
		autoReplyEnabled: boolean;
		autoReplySubject: string;
		autoReplyBody: string;
		autoReplyStartAt: string | null;
		autoReplyEndAt: string | null;
	};
	error?: unknown;
};

export type ChangePasswordResponse = {
	error?: unknown;
};

export type ProfileAvatarSessionResponse = {
	user?: {
		hasAvatar?: boolean;
	};
};

export type ProfileAvatarUploadResponse = {
	error?: string;
};

export type ProfileAvatarFormProps = {
	mailboxId?: string;
	initialHasAvatar?: boolean;
	name?: string;
	colorSeed?: string;
};

export type CurrentMailboxFormResponse = {
	mailbox?: {
		id: string;
		domainId: string;
		localPart: string;
		hostname: string;
		displayName: string | null;
		signature?: string | null;
		hasAvatar?: boolean;
		isPrimary?: boolean;
	};
	error?: unknown;
};
