export type MailingListDomain = {
	id: string;
	hostname: string;
	status: string;
};

export type MailingList = {
	id: string;
	userId: string;
	domainId: string;
	localPart: string;
	hostname: string;
	address: string;
	name: string;
	description: string | null;
	postingPolicy: "members_only" | "anyone";
	moderated: boolean;
	disabled: boolean;
	createdAt: string;
	memberCount: number;
};

export type MailingListMember = {
	id: string;
	listId: string;
	email: string;
	name: string | null;
	role: "owner" | "member";
	moderated: boolean;
	createdAt: string;
};

export type MailingListsResponse = {
	lists: MailingList[];
};

export type MailingListResponse = {
	list: MailingList;
};

export type MailingListDomainsResponse = {
	domains: MailingListDomain[];
};

export type MailingListMembersResponse = {
	members: MailingListMember[];
};
