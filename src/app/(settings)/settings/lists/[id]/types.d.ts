import type { MailingList, MailingListMember } from "../types";

export type MailingListDetailResponse = {
	list: MailingList;
	members: MailingListMember[];
};

/** PATCH returns the list row only — no member count. */
export type MailingListUpdateResponse = {
	list: Omit<MailingList, "memberCount">;
};
