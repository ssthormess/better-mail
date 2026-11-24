export type MailboxUsageBreakdown = {
	bodyBytes: number;
	attachmentBytes: number;
	messageCount: number;
};

export type MailboxUsageResponse = {
	mailboxId: string;
	storageUsed: number;
	breakdown: MailboxUsageBreakdown;
	computedAt: string;
	error?: string;
};

export type MailboxUsageCardProps = {
	mailboxId: string;
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access" | null;
};
