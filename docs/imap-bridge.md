# IMAP bridge

An IMAP4rev1 endpoint for mail apps and scripts, served by the self-hosted (Node) runtime next to the web app and the SMTP listener. It is **off by default** and speaks only to app passwords.

Two limits are worth reading before anything else:

- **No message bodies.** `FETCH` serves `FLAGS` and `UID`, nothing else: `ENVELOPE`, `BODY`, `RFC822` and `BODY[]` answer `BAD`. The bridge lists mailboxes, counts, flags and search hits, and it can create folders, append a message and move a message — it cannot hand a client its mail. A desktop or phone mail client that downloads messages will connect, list mailboxes and then fail to read any mail. Use it for scripts, monitoring and tooling; use JMAP (or the web app) for reading mail.
- **Read-only flags.** `SELECT` and `EXAMINE` both answer `[READ-ONLY]` with `PERMANENTFLAGS ()`. `STORE`, `COPY` and `EXPUNGE` are not implemented, so a client cannot mark mail read, flag it or delete it over IMAP.

The Cloudflare Workers deployment has no IMAP listener; this is the Docker/Node server only.

## Setup

### 1. Turn the switch on

**Admin → General → "Allow mail apps to connect over IMAP"** (`app_settings.imap_enabled`, default off).

With the switch off:

- `LOGIN` answers `NO IMAP disabled`, and the "Read mail over IMAP" choice is not offered when creating an app password. The switch is read per connection and cached for 30 seconds per process, so a change reaches a running server within that window.
- The port still binds and answers with its banner — that is all it says.

With the switch on, an app password created afterwards can carry the `imap` scope. An **already-open session is not closed** when the switch is turned off: the check happens at `LOGIN`. Turn the switch off and restart the server if you need existing connections gone.

### 2. Environment

| Variable | Default | Purpose |
|---|---|---|
| `IMAP_PORT` | `993` with certificates, `143` without | Port the listener binds. `0` disables it. A non-numeric value also disables it. |
| `IMAP_HOST` | `0.0.0.0` | Address the listener binds. |
| `IMAP_TLS_KEY` | unset | Path to the private key for implicit TLS. |
| `IMAP_TLS_CERT` | unset | Path to the certificate for implicit TLS. |

The two certificate paths are a pair: set **both** or neither. One alone is treated as neither. The certificate files are read once at start, so a bad path is a startup error rather than a listener without TLS.

Everything else about the bridge is fixed and has no environment variable: the mailbox hierarchy delimiter is `/`, `APPEND` accepts up to 10 MiB (the same `LIMITS.maxSizeUpload` the JMAP upload endpoint uses) with 32 MiB of literals buffered across all connections at once, `IDLE` polls every 15 seconds and closes at 29 minutes, and `SEARCH` answers the `UTF-8` and `US-ASCII` charsets.

### 3. TLS

The listener is **implicit TLS or plaintext** — there is no `STARTTLS` command (it answers `NO Not implemented yet` and is not advertised). With `IMAP_TLS_KEY` and `IMAP_TLS_CERT` the TLS handshake starts on the first byte, the default port is 993, and clients must be configured as "SSL/TLS", not "STARTTLS". Without them the default port is 143 and everything, app password included, crosses the wire in the clear; put the bridge on a private network or a TLS tunnel if that matters to you. The startup log says which of the two it is:

```
IMAP listener listening on 0.0.0.0:993 (TLS)
IMAP listener listening on 0.0.0.0:143 (plaintext)
```

The Docker images publish only ports 3000 and 25, so add the IMAP port yourself. Published on the standard port, with certificates in a mounted directory:

```yaml
    ports:
      - "3000:3000"   # web app and JMAP
      - "25:25"       # inbound SMTP
      - "993:993"     # IMAP over TLS
    environment:
      - IMAP_TLS_KEY=/data/tls/imap.key
      - IMAP_TLS_CERT=/data/tls/imap.crt
```

Ports below 1024 need root or a capability, as with SMTP; `IMAP_PORT=1143` plus a port mapping is the usual way around that.

### 4. An app password

**Settings → App passwords → Create app password**, tick **Read mail over IMAP**, and pick the mailboxes it may use. The password is shown once. The `imap` choice only exists while the administrator switch is on, and the mailbox selection is enforced on every connection: a password limited to one mailbox cannot `LIST`, `SELECT` or search another, and a shared mailbox appears only while its grant allows it.

Spaces and dashes in the password are ignored, so a grouped password can be typed as shown.

## Connecting a client

| Setting | Value |
|---|---|
| Server | Your host name |
| Port | `993` (TLS) or `143` (plaintext) |
| Security | SSL/TLS, implicit. STARTTLS is not offered |
| Username | Your email address — **not checked**, any value works |
| Password | The app password with the `imap` scope |

The username is ignored: the app password identifies the account and its mailboxes. Fill in the full address anyway, because most clients refuse to connect without it.

Mailbox names follow one rule: the account's primary mailbox holds bare names (`INBOX`, `Sent`, `Drafts`, `Archive`, `Junk`, `Trash`, and each custom folder by name), and every other mailbox is namespaced under its address behind a `\Noselect` parent (`sales@example.com`, then `sales@example.com/INBOX`, `sales@example.com/Sent`, …). Folders are flat: the only delimiter use is that `addr/` prefix, so `addr/A/B` names a folder that cannot exist. Non-ASCII names travel as modified UTF-7 (RFC 3501 §5.1.3).

## What is implemented

`CAPABILITY` answers:

```
* CAPABILITY IMAP4rev1 MOVE IDLE ID APPENDLIMIT=10485760
```

| Command | Answer |
|---|---|
| `LOGIN`, `LOGOUT` | Yes. `LOGIN` only before authentication; the session ends on `LOGOUT` |
| `CAPABILITY`, `NOOP`, `ID` | Yes. `NOOP` answers only its tagged OK — it does not report counts |
| `LIST` | Yes, with `*`/`%` wildcards and a reference. Attributes are `\HasNoChildren`, or `\HasChildren \Noselect` on the `addr/` parents |
| `LSUB` | Yes, and answers exactly what `LIST` would: there is no subscription list. `SUBSCRIBE`/`UNSUBSCRIBE` answer `NO Not implemented yet` |
| `STATUS` | `MESSAGES`, `UNSEEN`, `RECENT`, `UIDNEXT`, `UIDVALIDITY`. Unknown items are ignored; a request with none of these answers `BAD` |
| `SELECT`, `EXAMINE` | Both open the mailbox **read-only** and answer `[READ-ONLY]` |
| `CREATE`, `DELETE`, `RENAME` | Yes, with the rules below. Modified UTF-7 names, 80-character cap, case-insensitive name uniqueness |
| `APPEND` | Yes, through the same import path the app and JMAP use (see below) |
| `FETCH`, `UID FETCH` | `FLAGS` and `UID` **only**. A sequence set outside the mailbox is `BAD`, and `FETCH` on an empty mailbox is `BAD Mailbox is empty` |
| `SEARCH`, `UID SEARCH` | The criteria below. An unsupported criterion is `BAD`, never silently ignored |
| `MOVE`, `UID MOVE` | Yes, within one mailbox. Answers descending `* n EXPUNGE` for what left, then its tagged OK |
| `IDLE` | Yes (RFC 2177), selected mailbox only, count polling (see below) |
| `CLOSE`, `UNSELECT` | Both simply deselect. Nothing is expunged, because nothing is stored that `CLOSE` could expunge |
| `STORE`, `COPY`, `EXPUNGE` (and `UID` forms), `CHECK`, `SUBSCRIBE`, `UNSUBSCRIBE`, `NAMESPACE`, `AUTHENTICATE`, `STARTTLS`, anything else | `NO Not implemented yet` |

`SEARCH` keys that answer, and what they read:

| Criterion | Reads |
|---|---|
| `ALL` | Every message |
| `SEEN`, `UNSEEN` | The read flag; outbound mail always counts as `\Seen` |
| `FLAGGED`, `UNFLAGGED` | The starred flag |
| `DELETED`, `UNDELETED` | Trash or Spam |
| `DRAFT`, `UNDRAFT` | Draft status |
| `SUBJECT`, `FROM`, `TO`, `CC`, `BCC` | That column, substring |
| `TEXT`, `BODY` | Substring over subject, addresses and body |
| `SINCE`, `BEFORE`, `ON` | The arrival date, as a UTC day |
| `SENTSINCE`, `SENTBEFORE`, `SENTON` | The same column: no separate sent date is stored |
| a sequence set, `UID <set>` | Positions (see below) |
| `NOT`, `OR`, `( … )` | As written. Prefix notation only |

`ANSWERED`, `UNANSWERED`, `KEYWORD`, `UNKEYWORD`, `HEADER`, `LARGER`, `SMALLER` and `MODSEQ`/`REVERSE` answer `BAD` with the reason (no answered state, no keyword column, no arbitrary headers, no stored size). A charset other than `UTF-8` or `US-ASCII` answers `NO [BADCHARSET (UTF-8 US-ASCII)]`. Infix `SEEN OR FLAGGED`, a short `OR`, and `NOT A OR B` are grammar errors (`BAD`), not reinterpreted.

## What the bridge will not do honestly

This is the part worth reading twice: each item is a deliberate answer to something the data model cannot express, not a bug waiting to be fixed.

### UIDs are positions

Sequence number and UID are the same number: the message's 1-based position in the mailbox, ordered by arrival time. There is no per-message UID column. So:

- `UIDNEXT` is the current message count + 1, `UID FETCH` echoes back the position, and `UID SEARCH` returns positions.
- `UIDVALIDITY` is a hash of the mailbox's internal reference. It is stable for a mailbox across sessions, survives a rename (the reference does), and changes when a folder is deleted and recreated (a new folder gets a new reference) — which is what `UIDVALIDITY` is for.
- A message inserted *before* existing mail (an import with an older date, or an `APPEND` carrying an older internal date) shifts every later position **without** changing `UIDVALIDITY`. A client holding old UIDs can therefore be pointing at the wrong message. Treat the mailbox as changed and re-`SELECT` after anything that could backfill mail.
- An out-of-range number in a sequence set is `BAD`, not "no such message": with positional UIDs it means the client's view is stale, and saying so is more useful than an empty answer.

### Deletions are invisible until the client resyncs

`* n EXPUNGE` is sent for exactly one thing: a `MOVE` this session performed. Every other removal — another session's `MOVE`, a message trashed in the web app, a filter — is **not announced**, because positional UIDs cannot name which position left (removing position 3 would shift every later number, so an EXPUNGE would lie).

The client learns the true state from its next `SELECT`, or from a `STATUS` it asks for itself (then refreshes). `NOOP` does **not** report the count here, so a `NOOP`-and-wait refresh loop will not see a shrink, and neither does `IDLE`:

- `* n EXISTS` is only ever sent for a **higher** total than the client already knows. `IDLE` pushes a total that rose; it never announces one that fell. RFC 3501 §5.2 forbids lowering the selected count without an `EXPUNGE`, and this bridge cannot honestly send one.
- So a mailbox that gains three and loses three looks unchanged, and a replacement that keeps the total the same is invisible. A client that must be exact should re-`SELECT` (or `STATUS`) periodically.

### Recent

`\Recent` is never set: Mailflare does not track which session saw a message first. `SELECT` answers `* 0 RECENT`, `STATUS` answers `RECENT 0`, `SEARCH NEW` and `SEARCH RECENT` return nothing, and `SEARCH OLD` returns everything. `NEW` is `RECENT UNSEEN` in RFC 3501, so the consistent answer is empty; ask `UNSEEN` for unread mail.

### Flags

`SELECT` advertises `* FLAGS (\Seen \Flagged \Draft \Deleted)` and `* OK [PERMANENTFLAGS ()]`. `\Answered` is absent because no answered/replied state is stored, `\Recent` for the reason above, and `PERMANENTFLAGS ()` on every mailbox because nothing is writable — including `EXAMINE`, which is why both verbs answer `[READ-ONLY]`.

Flags that are reported: `\Seen` (read, and always for outbound mail), `\Flagged` (starred), `\Draft` (draft status), `\Deleted` (in Trash or Spam). `APPEND` accepts exactly those four and drops anything else (`\Recent`, keywords, `$labels`) instead of echoing back a flag nothing stores.

### IDLE is a poll

`IDLE` is selected-state only (`BAD No mailbox selected`), and everything except `DONE` while idling answers `BAD Only DONE ends IDLE` with the session still idling.

- Push is **count polling**: one count query per idling connection every 15 seconds. A new message normally appears within 15 seconds plus the query and event-loop time, and later if a poll's query fails (the next tick retries; the session survives).
- Only the total is pushed. A flag change — including a message becoming unread — sends nothing, and there is no per-message `FETCH` update (no CONDSTORE, no QRESYNC).
- Access is re-checked **on every tick**: if a shared-mailbox grant is revoked, the mailbox is disabled or it is deleted while a client idles, the `IDLE` ends with its tagged `OK` and no count rather than leaking activity.
- A 29-minute deadline ends the IDLE with its tagged OK, so a client behind a NAT should send `IDLE` again. An idling connection is exempt from the 60-second inactivity timeout below.

### Folder operations

- `CREATE` of an existing name (case-insensitively) is `NO Mailbox already exists`. Role names (`INBOX`, `Sent`, `Drafts`, `Archive`, `Junk`, `Trash`) and the `addr/` parents are not folders, and names longer than 80 characters are refused. No untagged `LIST` is sent; the client's next `LIST` finds the folder.
- `DELETE` **deletes the folder and unfiles its messages** — they go back to their status mailbox (a received message to `INBOX`, a draft to `Drafts`). This differs from JMAP, which refuses to destroy a non-empty folder unless told to trash its mail. Deleting the selected mailbox deselects the session.
- `RENAME` keeps the folder's identity, so messages stay in it and `UIDVALIDITY` does not change. A case-only rename is a no-op `OK`; a rename into another mailbox answers `NO RENAME cannot move a folder to another mailbox` (folders belong to one mailbox, and its messages could not follow).
- All three need **manage** rights on the mailbox: its owner, or a delegate with `full_access`.

### MOVE

`MOVE` is JMAP's `Email/set` membership change, reusing the same rule: the message keeps its id and its bytes, and only its mailbox membership changes. Therefore:

- A destination in **another mailbox of the account** is refused (`NO MOVE cannot move mail between mailboxes`), exactly as JMAP refuses it — a received message cannot be put in another mailbox's `Sent`, and one row belongs to one mailbox.
- No `EXPUNGE` command exists, so a client that wants to delete mail has nothing to call: `EXPUNGE`, `UID EXPUNGE` and `STORE +\Deleted` all answer `NO Not implemented yet`. Deletion is "move to Trash".

### APPEND

`APPEND` is stored through the same import path as uploads, REST import and JMAP: the MIME is parsed, threading, search indexing and the change journal are written, and attachments are stored. Consequences:

- The **destination decides the columns**, not the flags. Appending to `Sent` writes outbound mail owned by the appender; appending to `Drafts` writes a private draft; appending to `Trash` writes a trashed message. A message without `\Seen` is unread.
- `\Draft` on anything but `Drafts` is `NO` (`Drafts mail is only appendable to the Drafts mailbox`), and `\Deleted` on anything but `Trash` is `NO`. A draft flag on an inbox message would make it invisible in the mailbox it was appended to.
- An `X-Spam-Flag: yes` header still files the message into `Junk`, as everywhere else in the app — the import hints refine the destination. Do not append spam-flagged mail to `INBOX` and expect it there.
- Re-appending a message whose `Message-ID` is already in that mailbox answers **`OK`** without adding a row. There is no `APPENDUID` (no UIDPLUS), so the client cannot tell the two apart — a duplicate is "the message is there", which is what the client asked for. A message with no `Message-ID` has no identity to dedupe on and is stored again.
- A mailbox that does not exist answers `NO [TRYCREATE] No such mailbox`.
- **No `EXISTS` is sent after a successful `APPEND`.** The count the client holds is left alone, so a client that appends and then waits for an untagged `EXISTS` sees nothing until its next `SELECT`, `STATUS`, or a running `IDLE` tick.
- The internal date, when the client sends one, becomes the arrival time — and therefore the message's position in the UID order. An old date inserts it before newer mail.
- `APPEND` needs **manage** rights on the destination (`full_access`); a read-only or `send_as` delegate answers `NO APPEND is not allowed on this mailbox`. The `From:` header is not validated against the mailbox, the same way the import path does not — but only a delegate who can already manage (and therefore send as) that mailbox can reach it.

### Literals and limits

- One literal may be up to **10 MiB** (`APPENDLIMIT=10485760`, also the largest JMAP upload), and **32 MiB** of literals may be buffered across all connections at once. A larger literal gets a tagged `NO Literal too large`, its bytes are drained, and **the session survives** — the connection is not dropped.
- A *synchronizing* literal (no `+`) that the server refuses gets its `NO` before a continuation, which is what RFC 3501 §4.3 asks for.
- Command lines are capped at 64 KiB.

### Connections and timeouts

- At most 100 connections at once, and 10 per IP address. Beyond that the server answers `* BYE Too many connections` and closes.
- A connection that is not idling is closed after **60 seconds without a command**. RFC 3501 §5.4 asks for at least 30 minutes; the bridge is deliberately shorter. A client must poll (or `IDLE`) inside a minute.
- A connection that *is* idling is exempt, and the 29-minute IDLE deadline applies instead.

### Delegates

Shared mailboxes work through the same grants as the rest of the app, and connect with the delegate's own app password:

| Grant | What the bridge allows |
|---|---|
| `read_only` | `LIST`, `SELECT`, `EXAMINE`, `STATUS`, `FETCH`, `SEARCH`, `IDLE` on that mailbox |
| `send_as` (and `send_on_behalf`) | The same reads. No writes over IMAP: `APPEND`, `MOVE`, `CREATE`, `DELETE` and `RENAME` need `full_access`. Sending as the mailbox is SMTP/JMAP, not this bridge |
| `full_access` | Reads plus every write command above |

A mailbox the account cannot read is indistinguishable from one that does not exist: `SELECT` answers `NO No such mailbox` either way.

### Password guesses

A `LOGIN` with a password this process has not recently verified spends one guess from the per-IP rate limit (`DEVICE_LOGIN_RATE_LIMIT` or `LOGIN_RATE_LIMIT`, IPv6 bucketed by /64) *before* the password is looked up; a wrong guess beyond the budget answers `NO Authentication failed`. With no rate limiter configured nothing limits guesses, so configure one. Account passwords are never accepted, only app passwords with the `imap` scope; changing the account's password, its second step, or "sign out everywhere" revokes them all.
