# External accounts

A mailbox can pull mail out of other mail servers — an old provider, a backup MX, a server you are migrating off — and deliver it into the Mailflare inbox. Accounts are managed from the mailbox's settings page under **External accounts**: each entry is a server, a login and a protocol, and the poller brings new messages in roughly once a minute.

Access to this section matches the API: the mailbox owner and delegates with `full_access` can list, add, edit and remove accounts. Delegates with `read_only`, `send_as` or `send_on_behalf` do not see the section, and the API refuses them.

## Configuration

Each account takes a protocol, a server host, a port, a TLS mode, a username and a password.

| Protocol | implicit-tls | starttls | none |
| --- | --- | --- | --- |
| IMAP | 993 | 143 | 143 |
| POP3 | 995 | 110 | 110 |

- **implicit-tls** dials the TLS port directly and verifies the certificate and hostname. This is the default and the right choice for almost every server.
- **starttls** connects in plaintext and upgrades with STARTTLS before logging in; the certificate is still verified. A failed upgrade is not followed by a plaintext login.
- **none** sends the login and the mail in plaintext. Use it only on a trusted local network.

The port field prefills from the protocol/TLS pair but stays editable for non-standard setups.

## What the poller does

**IMAP** scans new UIDs oldest-first in bounded windows (at most 50 messages and 20 MiB per poll, each message capped at 5 MiB) starting from UID 1, so a large source mailbox fills in over successive polls rather than in one shot. The cursor records the server's `UIDVALIDITY`; if the server presents a different epoch (a recreated mailbox, a provider migration), polling restarts under the new epoch instead of fetching into the wrong UID space. Editing the account's source — protocol, host, port, TLS mode, username or password — resets the cursor, the last-fetched time and the warning state: Mailflare treats it as a different account and imports from the start again. `last_error` messages are sanitized, fixed strings and never carry server text or credentials.

**POP3** has no UID space: the cursor is the set of UIDL hashes the poller has already imported or skipped. Mail is *left on the server* — the poller never issues `DELE`, so the provider and other clients keep their copies. A POP3 server without `UIDL` support cannot be polled and fails closed rather than risking duplicates. A UIDL evicted from the bounded cursor refetches and deduplicates on the message's content key, so trimming the cursor does not re-import mail.

While a poll holds its lease on an account, edits and deletes are refused with a 409 until the lease expires; this keeps a slow source server from racing a settings change. Polls run inside the minute tick with their own per-account deadlines, so a hung server cannot stall the schedule.

**Skipped messages.** A message whose declared size exceeds the per-message fetch limit is recorded and skipped rather than fetched — the poll moves on without it. The account's `skippedUids` (IMAP) or `skippedUidls` (POP3, as hashes) list the most recent 128 of them and is what the settings page counts under the account. While the list is non-empty the account keeps a warning in `last_error`; it clears when the source changes (which resets the cursor) or, on IMAP, when the `UIDVALIDITY` epoch rolls. Skipped mail stays on the source server and can be moved manually.

## The encryption key

Passwords are stored encrypted with `MAILFLARE_ENCRYPTION_KEY` and there is no fallback: adding an account without a configured key fails closed with a 503, and a placeholder or too-short key is refused the same way. The API never returns a password or its ciphertext — a view only carries `passwordSet: true`, and editing sends a new password only when the field is filled. Generate the key once (`openssl rand -base64 32`, or `npx wrangler secret put MAILFLARE_ENCRYPTION_KEY` on Workers) and keep it: rotating it makes stored passwords unreadable until they are re-entered, and backups carry the sealed value, so restoring onto an install with a different key leaves the accounts listed but unable to fetch. See [self-hosting](self-hosting.md) for the variable.

## Polling runs on Node only

The poller is a self-hosted Node process. **On Cloudflare Workers and Vercel the account can be stored — credentials encrypt and list the same — but nothing ever polls it**: workerd's socket API differs from Node's `net`/`tls`, so the scheduled handler deliberately skips the poller there rather than fetch unsafely. The settings page will show the account with "not fetched yet" forever on those runtimes. Fetching external mail needs the self-hosted (Docker/Node) deployment.

## Security notes

- Passwords are only ever sealed at rest and decrypted in the poller process; they are never read back by the API, never logged, and a database error on a credential write is reduced to a classification code so the ciphertext cannot ride an error object into the logs.
- Fetched mail is imported through the normal inbound pipeline (MIME parsing, routing rules, spam classification, indexing) in `historical_import` mode, which suppresses notifications, auto-replies, bounces, webhooks and DMARC-report ingestion.
- Egress is LAN-deny by default: every resolved address must be public and routable, and DNS answers are re-checked right before dialing to prevent rebinding. Operators who intentionally fetch from a LAN server can set `EXTERNAL_FETCH_ALLOW_PRIVATE=1`; do not set it where mailbox managers are untrusted, since a full-access delegate could then point an account at internal addresses.
- Removing an account hard-deletes its row — the sealed password goes with it — and fetched mail stays in the mailbox.
