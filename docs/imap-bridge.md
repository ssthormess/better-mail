# IMAP bridge

A partial IMAP4rev1 bridge for mail apps and scripts, served by the self-hosted (Node) runtime next to the web app and the SMTP listener. It answers a useful subset of RFC 3501; it is not a complete IMAP server, and several of its answers are narrower than the RFC allows because of how Mailflare stores mail. Authentication is **off by default** and accepts only app passwords.

Three limits are worth reading before anything else:

- **No message bodies.** `FETCH` serves `FLAGS` and `UID`, nothing else: `ENVELOPE`, `BODY`, `RFC822` and `BODY[]` answer `BAD`. The bridge lists mailboxes, counts, flags and search hits; it cannot hand a client its mail, and a client that expects to download messages gets nothing back for them. Use it for scripts, monitoring and tooling; read mail with JMAP or the web app.
- **No flag editing and no expunge.** `SELECT` and `EXAMINE` both answer `[READ-ONLY]` with `PERMANENTFLAGS ()`, and `STORE`, `COPY` and `EXPUNGE` are not implemented. A client cannot change a flag on existing mail, mark it read, or expunge it.
- **It is not a read-only endpoint.** An authorized client can still `MOVE` a message (to `Trash`, or between folders of the same address), `APPEND` a message, and create, rename or delete folders. Those writes are real.

The Cloudflare Workers deployment has no IMAP listener; this is the Docker/Node server only.

## Setup

### 1. Turn authentication on

**Admin → General → "Allow mail apps to connect over IMAP"** (`app_settings.imap_enabled`, default off). It gates *sign-in*, not the listener: the port binds according to its configuration whether the switch is on or off.

With the switch off:

- `LOGIN` answers `NO IMAP disabled`, and the "Read mail over IMAP" choice is not offered when creating an app password.
- Everything legal before authentication still works — `CAPABILITY`, `ID`, `NOOP`, `LOGOUT` — so a client sees a normal server that refuses credentials.
- The switch is checked on **every `LOGIN` attempt** (a cached settings read), and the value is held for 30 seconds per process, so a change reaches a running server within that window. A missing or unreadable setting counts as off.

With the switch on, an app password created afterwards can carry the `imap` scope. An **already-authenticated session is not closed** when the switch is turned off: the check happens at `LOGIN`, and a session's identity is the snapshot taken then. Turn the switch off and restart the server if you need existing connections gone.

### 2. Environment

| Variable | Default | Purpose |
|---|---|---|
| `IMAP_PORT` | `993` with certificates, `143` without | Port the listener binds. Overrides either default. `0` disables the listener; a non-numeric value also disables it. |
| `IMAP_HOST` | `0.0.0.0` | Address the listener binds. |
| `IMAP_TLS_KEY` | unset | Path to the private key for implicit TLS. |
| `IMAP_TLS_CERT` | unset | Path to the certificate for implicit TLS. |

The two certificate paths are a pair: set **both** or neither. One alone is treated as neither, and the default port then falls back to 143. The files are read once at start, so a bad path is a startup error rather than a listener without TLS.

Everything else about the bridge is fixed and has no environment variable: the mailbox hierarchy delimiter is `/`, `APPEND` accepts up to 10 MiB per message (the same `LIMITS.maxSizeUpload` the JMAP upload endpoint uses) with 32 MiB of literal reservations shared across all connections, `IDLE` polls every 15 seconds and ends after 29 minutes, and `SEARCH` answers the `UTF-8` and `US-ASCII` charsets. Only the test suite overrides the timer and buffer values.

### 3. TLS

The listener is **implicit TLS or plaintext** — there is no `STARTTLS` command. Before authentication an unknown verb answers `BAD Authenticate first`; after it, `STARTTLS` answers `NO Not implemented yet`. Nothing advertises it.

With `IMAP_TLS_KEY` and `IMAP_TLS_CERT` the TLS handshake starts on the first byte, the default port is 993, and clients must be configured as "SSL/TLS", not "STARTTLS". Without them the default port is 143 and everything, app password included, crosses the wire in the clear; put the bridge on a private network or a TLS tunnel if that matters. The startup log says which of the two it is:

```
IMAP listener listening on 0.0.0.0:993 (TLS)
IMAP listener listening on 0.0.0.0:143 (plaintext)
```

The bundled Compose files publish ports 3000 and 25 only (the image *exposes* the same two), so a port mapping is needed for mail apps to reach the listener from outside the container network. The container runs as an unprivileged user, so binding a port below 1024 inside it depends on the host's unprivileged-port threshold. The safe shape is a high port inside and the standard port outside, with the certificate files readable by that user:

```yaml
    ports:
      - "3000:3000"   # web app and JMAP
      - "25:25"       # inbound SMTP
      - "993:1143"    # IMAP over TLS
    environment:
      - IMAP_PORT=1143
      - IMAP_TLS_KEY=/data/tls/imap.key
      - IMAP_TLS_CERT=/data/tls/imap.crt
```

Mount the directory holding the files so they are readable inside the container (a copy under `/data` survives a container rebuild, but a full volume backup then contains the private key). For a plaintext listener, leave both certificate variables out and map `143:1143` instead — and only expose that on a trusted network.

### 4. An app password

**Settings → App passwords → Create app password**, tick **Read mail over IMAP**, and pick the mailboxes it may use. The password is shown once. The `imap` choice only exists while the administrator switch is on, and the mailbox selection is part of what the connection sees: a password limited to one mailbox cannot `LIST`, `SELECT` or search another, and a shared mailbox appears only while its grant allows it.

Spaces and dashes in the password are ignored, so a grouped password can be typed as shown.

## Connecting a client

| Setting | TLS listener | Plaintext listener |
|---|---|---|
| Server | Your host name | Your host name |
| Port | `993` (or whatever `IMAP_PORT` says) | `143` (or whatever `IMAP_PORT` says) |
| Security | SSL/TLS, implicit | None. Do not choose STARTTLS |
| Username | Your email address; syntax only, not verified | same |
| Password | The app password with the `imap` scope | same |

`LOGIN` requires a username argument but does not check it: the app password identifies the account and its mailboxes. Enter the full address as a matter of habit, not because it is validated.

Mailbox names follow one rule: bare names (`INBOX`, `Sent`, `Drafts`, `Archive`, `Junk`, `Trash`, and each custom folder by name) exist for the account's **primary mailbox only when that mailbox is in the app password's scope**; every other mailbox is namespaced under its address behind a `\Noselect` parent (`sales@example.com`, then `sales@example.com/INBOX`, `sales@example.com/Sent`, …). With no visible primary, every mailbox is namespaced. A custom folder whose name collides with a role name or differs only by case from another folder is left out of the catalogue, so it will not appear in `LIST`. Folders are flat: the only delimiter use is that `addr/` prefix, so IMAP cannot create `addr/A/B`. Non-ASCII names travel as modified UTF-7 (RFC 3501 §5.1.3).

## What is implemented

`CAPABILITY` answers:

```
* CAPABILITY IMAP4rev1 MOVE IDLE ID APPENDLIMIT=10485760
```

Nothing else is advertised: no `LITERAL+`, `UIDPLUS`, `UNSELECT`, `CONDSTORE`, `QRESYNC`, `SASL-IR` or `STARTTLS`. `{n+}` literals are nevertheless accepted.

| Command | Answer |
|---|---|
| `LOGIN`, `LOGOUT` | Yes. `LOGIN` only before authentication; `LOGOUT` drops the session |
| `CAPABILITY`, `NOOP`, `ID` | Yes, in any state. `NOOP` answers only its tagged OK — it reports no counts and sends no untagged data |
| `LIST` | Yes. A reference scopes the pattern only when it ends in `/`; an empty pattern answers the single `\Noselect` delimiter reply. Attributes are `\HasNoChildren`, or `\HasChildren \Noselect` on the `addr/` parents |
| `LSUB` | Yes, and returns the same entries as `LIST`, with `LSUB` as the verb in both the untagged and tagged replies: there is no subscription list. `SUBSCRIBE`/`UNSUBSCRIBE` are not implemented |
| `STATUS` | `MESSAGES`, `UNSEEN`, `RECENT`, `UIDNEXT`, `UIDVALIDITY`. Unknown items are ignored; a request for only unknown items answers `BAD` once the mailbox resolved |
| `SELECT`, `EXAMINE` | Both open the mailbox **read-only** and answer `[READ-ONLY]` |
| `CREATE`, `DELETE`, `RENAME` | Yes, with the rules below. Modified UTF-7 names, 80-character cap, case-insensitive name uniqueness |
| `APPEND` | Yes, through the shared import service (see below) |
| `FETCH`, `UID FETCH` | `FLAGS` and `UID` **only**. A data item outside those two is `BAD`, a sequence set outside the mailbox is `BAD`, and `FETCH` on an empty mailbox is `BAD Mailbox is empty` |
| `SEARCH`, `UID SEARCH` | The criteria below. An unsupported criterion is `BAD`, never silently ignored |
| `MOVE`, `UID MOVE` | Yes, within one address. Answers descending `* n EXPUNGE` for what left, then its tagged OK |
| `IDLE` | Yes (RFC 2177), selected mailbox only, count polling (see below) |
| `CLOSE`, `UNSELECT` | Both require a selection and no arguments, and simply deselect. Nothing is expunged, because nothing is stored that `CLOSE` could expunge |
| `STORE`, `COPY`, `EXPUNGE` (and their `UID` forms), `CHECK`, `SUBSCRIBE`, `UNSUBSCRIBE`, `NAMESPACE`, `AUTHENTICATE`, `STARTTLS`, anything else | After authentication: `NO Not implemented yet`. Before it: `BAD Authenticate first` |

`SEARCH` keys that answer, and what they read:

| Criterion | Reads |
|---|---|
| `ALL` | Every message |
| `SEEN`, `UNSEEN` | The read flag; outbound mail always counts as `\Seen` |
| `FLAGGED`, `UNFLAGGED` | The starred flag |
| `DELETED`, `UNDELETED` | The trash marker (mail in Trash or Spam) |
| `DRAFT`, `UNDRAFT` | Draft status |
| `SUBJECT`, `FROM`, `TO`, `CC`, `BCC` | That column, substring |
| `BODY` | Substring over the text and HTML body columns only |
| `TEXT` | Substring over `BODY`'s columns plus the subject and the four address columns |
| `SINCE`, `BEFORE`, `ON` | The arrival date, as a UTC day |
| `SENTSINCE`, `SENTBEFORE`, `SENTON` | The same column: no separate sent date is stored |
| a sequence set, `UID <set>` | Positions, resolved against the messages that exist (see below) |
| `NOT`, `OR`, `( … )` | As written. Prefix notation only |

`ANSWERED`, `UNANSWERED`, `KEYWORD`, `UNKEYWORD`, `HEADER`, `LARGER` and `SMALLER` answer `BAD` with the reason: no answered state, no keyword column, no arbitrary headers, no stored size. `MODSEQ` and `REVERSE` answer `BAD` as unsupported extensions (no `CONDSTORE`, no `SORT`/`THREAD`). A charset other than `UTF-8` or `US-ASCII` answers `NO [BADCHARSET (UTF-8 US-ASCII)]`. Infix `SEEN OR FLAGGED`, a short `OR`, and `NOT A OR B` are grammar errors (`BAD`), not reinterpreted.

## Behavior and limits

Each item below is a deliberate answer to something the data model cannot express, or a bound on how much the bridge does. Read it before trusting an answer.

### UIDs are positions

Sequence number and UID are the same number: the message's 1-based position in the mailbox, ordered by arrival time and, for equal arrival times, by message id. There is no per-message UID column. So:

- `UIDNEXT` is the current message count + 1, `UID FETCH` echoes back the position, and `UID SEARCH` returns positions.
- `UIDVALIDITY` is a derived 31-bit value (FNV-1a of the mailbox reference, folded into 1…2147483646). It is stable for a mailbox across sessions, survives a rename (the reference does), and a folder deleted and recreated normally gets a different reference and therefore a different value — a convention, not a mathematical guarantee.
- A message inserted *before* existing mail (an import with an older date, or an `APPEND` carrying an older internal date) shifts every later position **without** changing `UIDVALIDITY`. A client holding old UIDs can then be pointing at the wrong message, and re-`SELECT`ing alone will not invalidate its cache. Refetch and rebuild the cached positions if that matters.
- `FETCH`, `MOVE` and their `UID` forms refuse an out-of-range number with `BAD`: with positional UIDs it means the client's view is stale, and saying so is more useful than an empty answer. `SEARCH` and `UID SEARCH` do the opposite, as RFC 3501 §6.4.4 asks: positions that do not exist are ignored, and a set that matches nothing returns an empty result.

### Deletions and counts

`* n EXPUNGE` is sent for exactly one thing: a `MOVE` this session performed. Every other removal — another session's `MOVE`, a message trashed in the web app, a filter — is **not announced**, because positional UIDs cannot name which position left (removing position 3 would shift every later number, so an EXPUNGE would lie).

What a client can learn, and when:

- A fresh `SELECT` or `EXAMINE` reports the **real** count, even a lower one. That is the resynchronization point.
- An unsolicited `* n EXISTS` — that is, `IDLE`'s push — is only ever sent for a **higher** total than this connection was last told. It never announces a total that fell. RFC 3501 §5.2 forbids lowering the selected count without an `EXPUNGE`, and this bridge cannot honestly send one.
- `STATUS` reports real counts for any mailbox, but it emits no untagged `EXISTS` and does not reset the count a running selection was told. Ask for `MESSAGES`, then let the client refresh its own view: a mailbox that gained three and lost three — or replaced three with three — looks unchanged to anything count-based, and only a reselect plus refetch shows the difference.
- `NOOP` reports nothing here. A `NOOP`-and-wait refresh loop learns only what its own client re-reads.

### Recent

`\Recent` is never set: Mailflare does not track which session saw a message first. `SELECT` answers `* 0 RECENT`, `STATUS` answers `RECENT 0`, `SEARCH NEW` and `SEARCH RECENT` return nothing, and `SEARCH OLD` returns everything. `NEW` is `RECENT UNSEEN` in RFC 3501, so the consistent answer is empty; ask `UNSEEN` for unread mail.

### Flags

`SELECT` advertises `* FLAGS (\Seen \Flagged \Draft \Deleted)` and `* OK [PERMANENTFLAGS ()]`. `\Answered` is absent because no answered/replied state is stored, `\Recent` for the reason above, and `PERMANENTFLAGS ()` on every mailbox because no flag on existing mail is writable — including on `EXAMINE`, which is why both verbs answer `[READ-ONLY]`.

Flags that are reported: `\Seen` (read, and always for outbound mail), `\Flagged` (starred), `\Draft` (draft status), `\Deleted` (trash marker). `APPEND` accepts exactly those four and drops anything else (`\Recent`, keywords, `$labels`) instead of echoing back a flag nothing stores.

### IDLE is a poll

`IDLE` is selected-state only (`BAD No mailbox selected`), and while idling every line except `DONE` answers `BAD Only DONE ends IDLE` — including a command that starts with a literal marker. The session keeps idling.

- Push is **count polling**: one count query per idling connection per 15-second tick, plus the access reads that decide whether the session may still read the mailbox. The next timer starts after the previous query finishes, so a slow query delays the tick instead of stacking.
- Only the total is pushed. A flag change — including a message becoming unread — sends nothing, and there is no per-message `FETCH` update (no `CONDSTORE`, no `QRESYNC`). A poll whose query fails is silent; the next tick retries, and the session survives.
- Access is re-checked **on every tick**, but only as "may this connection still read this mailbox": a revoked shared-mailbox grant, a disabled or deleted address, or a mailbox-scoped password losing the mailbox ends the `IDLE` with its tagged `OK` and no count. Deleting the selected *custom folder* while it idles does not end it — the mailbox is still readable and the count simply becomes 0, which is a fall and therefore silent. The app password itself is not re-read: authorization is the `LOGIN` snapshot.
- The count is whatever the client was last told plus any `EXPUNGE` this session emitted, so a session that just moved mail away does not get a stale, higher number replayed.
- A 29-minute deadline ends the **`IDLE`** with its tagged `OK`; the connection stays open and the ordinary inactivity timer is armed again. A client behind a NAT should send `IDLE` again.
- `APPEND` cannot run on the same connection while it idles. Growth from another connection reaches an idling client at the next tick, and only above the total it was last told.

### Folder operations

- `CREATE` of an existing name (case-insensitively) is `NO Mailbox already exists`; a reserved role name or an `addr/` parent is `NO CREATE is not allowed on this mailbox`, and a name longer than 80 characters is refused. No untagged `LIST` is sent; the client's next `LIST` finds the folder.
- `DELETE` **deletes the folder and unfiles its messages** — they go back to their status mailbox (a received message to `INBOX`, a draft to `Drafts`). This differs from JMAP, which refuses to destroy a non-empty folder unless told to trash its mail. Deleting the selected mailbox deselects the session.
- `RENAME` keeps the folder's identity, so messages stay in it and `UIDVALIDITY` does not change. A same-name or case-only rename is a no-op `OK` returned before any rights check; a rename into another address answers `NO RENAME cannot move a folder to another mailbox` when the new name is a valid new folder (a reserved or existing name is refused first, on its own terms), because folders belong to one address and their messages could not follow.
- Mutating a folder — create, delete, rename — needs **manage** rights on its mailbox: the owner, or a delegate with `full_access`.
- A folder name stored by another path (JMAP, REST) may contain `/`. The catalogue does not rewrite such a name, so it appears with the delimiter in it even though IMAP itself could not have created it.

### MOVE

`MOVE` reuses JMAP's mailbox-target rule, so the row keeps its id and its bytes, but it is a real update: the message's status, its folder, the derived trash state and, for drafts, its private-draft visibility and change-feed entry all move with it. Therefore:

- A destination in **another address** is refused (`NO MOVE` / `NO UID MOVE cannot move mail between mailboxes`, labelled with the command that was sent). Received mail cannot be moved into `Sent`, not even `Sent` of the same address — the same refusal JMAP gives.
- No `EXPUNGE` command exists, so a client that wants to delete mail has nothing to call: `EXPUNGE`, `UID EXPUNGE` and `STORE +\Deleted` are all `NO Not implemented yet`. Deletion is "move to Trash".

### APPEND

`APPEND` is stored by the same import service that handles REST and Takeout imports — not by JMAP's `Email/import`, which has its own upload, draft and `From:` validation path. The MIME is parsed, threaded and indexed, attachments are stored, and search and the change feed are updated. Consequences:

- The **destination decides the columns**, not only the flags. Appending to `Sent` writes outbound mail owned by the appender; appending to `Drafts` writes a private draft; appending to `Trash` writes a trashed message.
- `\Seen` and `\Flagged` on a new row set the read and starred columns, so a message appended without `\Seen` is unread. Mail appended to `Sent` still renders `\Seen` and never counts as unread, because outbound mail is always seen.
- `\Draft` on anything but `Drafts` is `NO` (`Drafts mail is only appendable to the Drafts mailbox`), and `\Deleted` on anything but `Trash` is `NO`. A draft flag on an inbox message would make it invisible in the mailbox it was appended to.
- A spam or trash hint from the message's own headers (`X-Spam-Flag: yes`, Gmail labels) only redirects an `INBOX` append — and only when no other section hint already won. An explicit `Sent`, `Drafts`, `Trash` or custom-folder destination is kept.
- Re-appending a message whose `Message-ID` the import path already stored answers **`OK`** without adding a row. Two caveats: the duplicate is matched anywhere in the same underlying mailbox (not necessarily the folder you named), and the existing row may gain `\Seen`/`\Flagged` from the new copy — but its flags are never removed, and it is never relocated. A message with no `Message-ID` has no identity to dedupe on and is stored again.
- A mailbox that does not exist answers `NO [TRYCREATE] No such mailbox`.
- **No `EXISTS` is sent after a successful `APPEND`.** The count the client holds is left alone, so a client that appends and then waits for an untagged `EXISTS` sees nothing until its next `SELECT`, `STATUS`, or a running `IDLE` tick.
- The internal date, when the client sends one, becomes the arrival time — and therefore the message's position in the UID order. An old date inserts it before newer mail.
- `APPEND` needs **manage** rights on the destination (`full_access`); a read-only or `send_as` delegate answers `NO APPEND is not allowed on this mailbox`. The `From:` header is not validated against the mailbox, as on the rest of the import path — but only a delegate who can already manage (and therefore send as) that mailbox can reach it.

### Literals and limits

- One literal may be up to **10 MiB** (`APPENDLIMIT=10485760`, also the largest JMAP upload). A larger one gets a tagged `NO Literal too large` and **the session survives**.
- Separately, literals are **reserved against a shared 32 MiB budget**: a `{n}` marker reserves its bytes until the command is answered, and a marker that does not fit is refused the same way an oversized one is. It is accounting, not a memory cap — the reader also copies the buffer it is filling, so real usage peaks above it.
- A refused literal's bytes are drained only when they are actually on the way: a non-synchronizing `{n+}` payload (and the CRLF after it) is discarded, and a synchronizing literal the client had already started sending is drained too. A normal rejected synchronizing literal never got a continuation, so the client owes nothing and the next line parses as a command. While `IDLE` is open, a literal-bearing line answers `BAD` rather than `NO`.
- The server refuses to buffer a line that has grown past 64 KiB while it is still waiting for the CRLF that ends it; it is not a limit on the length of a complete command line.

### Connections and timeouts

- At most 100 connections at once, and 10 per IP address. Beyond that the server answers `* BYE Too many connections` and closes.
- A connection that is not idling and exchanges nothing for **60 seconds** is closed. This is socket inactivity, not a completed command: any traffic resets it. RFC 3501 §5.4 asks for at least 30 minutes; the bridge is deliberately shorter, so a client must poll (or `IDLE`) inside a minute.
- A connection that *is* idling is exempt while it idles, and the 29-minute `IDLE` deadline applies instead.

### Delegates

Shared mailboxes work through the same grants as the rest of the app, and a delegate connects with their own app password:

| Grant | What the bridge allows |
|---|---|
| `read_only` | `LIST`, `SELECT`, `EXAMINE`, `STATUS`, `FETCH`, `SEARCH`, `IDLE` on that mailbox |
| `send_as` (and `send_on_behalf`) | The same reads. No writes over IMAP: `APPEND`, `MOVE`, folder changes need `full_access`. Sending as the mailbox is SMTP/JMAP, not this bridge |
| `full_access` | Reads plus every write command above |

A mailbox the account cannot read is indistinguishable from one that does not exist: `SELECT` answers `NO No such mailbox` either way.

### Password guesses

A `LOGIN` with a password this process has not recently verified spends one guess from the per-IP budget *before* the password is looked up; beyond the budget the answer is `NO Authentication failed`. The Node runtime installs an in-memory limiter with the platform binding's shape — 10 guesses per 60 seconds for device and app passwords, 20 for the general login fallback — so a Docker install is limited by default. The binding fails open: if it is missing or throws, guesses are not limited.

Account passwords are never accepted, only app passwords with the `imap` scope. Changing the account's password, its second step, an administrator reset or "sign out everywhere" removes those credentials, so the next `LOGIN` fails — but an IMAP session already authenticated keeps working until it disconnects, because its authorization was taken at `LOGIN`.
