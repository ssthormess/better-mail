# Calendar feed subscriptions

Mailflare can pull events into your calendar from an external calendar feed — the read-only `.ics` URLs that calendar apps publish under names like *Subscribe*, *webcal* or *iCal feed*. Use it for public holidays, team or school calendars, or a calendar you keep in another app.

## Subscribing

Open **Calendar**, then the options menu in the top bar, then **Feed subscriptions**. Paste the feed URL — `webcal://` and `https://` links both work (a `webcal` link is rewritten to `https` before it is stored) — and optionally give the feed a title and choose how often it is refreshed.

Subscribing does a first fetch and import right away, so it can take a few seconds for a large feed. The dialog tells you how many events were added and whether the feed contained events that could not be imported; the feed then shows up in the list with its event count.

Feed events appear inline in the calendar like any other event. They are read-only copies: editing or deleting them happens at the source, and the next refresh brings the change down. An event is identified by the feed it came through — the same event UID published by two different feeds lands as two separate events.

## Refreshing

A five-minute job checks every feed whose refresh interval has elapsed, asks the server for the feed with an `ETag`/`Last-Modified` validator, and only reimports when the feed actually changed. The interval you choose is the *minimum* time between checks, not a schedule — a feed set to hourly is polled at most once an hour, and only on a cron tick. Feeds of accounts with Calendar disabled are skipped.

The list shows each feed's refresh interval, when it was last checked and its state. A feed that has never run shows as pending.

## Feed errors

A failing refresh is recorded on the feed (`lastError`) and retried on the next due tick — it does not stop other feeds, and it does not remove events the feed already delivered:

- **Fetch failures** (host down, 404, timeouts) keep the stored events. Dropping the calendar on a transient upstream problem would make events flap, so events only leave when you unsubscribe.
- **`pinning_unavailable`** means the fetch was refused because this runtime cannot prove the outbound connection goes to the public internet. Cloudflare Workers assert it via `MAILFLARE_RUNTIME=cloudflare`; self-hosted or dev runtimes without that assertion fail closed — see [deployment](deployment.md#environment-variables).
- **"feed returned no usable events"** is a separate case: the fetch succeeded and parsed, but contained zero usable events (all cancelled or unsupported). To keep a degraded upstream from erasing every event it owns, Mailflare keeps the existing set and flags the feed instead.

## Editing and unsubscribing

The pencil button edits the title and refresh interval. The trash button unsubscribes: that removes the feed and deletes every event it imported — the only path that deletes feed events. Your own events are untouched.

## API

The dialog uses the same routes an API key with the `calendar:read`/`calendar:write` scopes can call; see [API and integrations](api.md#calendar).
