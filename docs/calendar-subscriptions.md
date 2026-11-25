# Calendar feed subscriptions

Mailflare can pull events into your calendar from an external calendar feed — the read-only `.ics` URLs that calendar apps publish under names like *Subscribe*, *webcal* or *iCal feed*. Use it for public holidays, team or school calendars, or a calendar you keep in another app.

## Subscribing

Open **Calendar**, then the options menu in the top bar, then **Feed subscriptions**. Paste the feed URL — `webcal://` and `https://` links both work (a `webcal` link is rewritten to `https` before it is stored) — and optionally give the feed a title and choose how often it is refreshed.

Subscribing does a first fetch and import right away, so it can take a few seconds for a large feed. The dialog reports how many events could not be imported and shows any notes the importer recorded; the feed then shows up in the list with its event count.

Feed events appear inline in the calendar like any other event. They are read-only copies — the API refuses edits and deletes on them, the assistant's calendar tools reject them the same way, and the next refresh would overwrite a local change anyway — so changes happen at the source and come down on the next refresh. An event is identified by the feed it came through — the same event UID published by two different feeds lands as two separate events.

## Refreshing

A five-minute job checks every feed whose refresh interval has elapsed — on the hosted Worker it runs from the five-minute cron, and on self-hosted installs the same job runs on the every-minute maintenance tick — asks the server for the feed with an `ETag`/`Last-Modified` validator, and only reimports when the feed actually changed. The interval you choose is the *minimum* time between checks, not a schedule — a feed set to hourly is polled at most once an hour, and only on a job tick. Feeds of accounts with Calendar disabled are skipped.

The list shows each feed's refresh interval, when it was last checked and its state. A feed that has never run shows as pending.

## Feed errors

A failing refresh is recorded on the feed (`lastError`) and retried on the next due tick — it does not stop other feeds, and it does not remove events the feed already delivered:

- **Fetch failures** (host down, 404, timeouts) keep the stored events. Dropping the calendar on a transient upstream problem would make events flap.
- **"Connection pinning is unavailable on this runtime"** means the fetch was refused because the runtime cannot prove the outbound connection goes to the public internet. Hosted Cloudflare Workers assert it by running with the `global_fetch_strictly_public` compatibility flag plus `MAILFLARE_RUNTIME=cloudflare` (see [deployment](deployment.md#environment-variables)); the self-hosted Node server pins every feed request's connection to the validated addresses itself; a self-hosted workerd has neither the assertion nor per-request pinning and fails closed. On a refresh the row shows this message in `lastError` with a null `lastRefreshStatus` — it is an internal fetch error code, not an HTTP status.
- **"feed returned no usable events"** is a separate case: the fetch succeeded and parsed, but contained zero usable events (all cancelled or unsupported). To keep a degraded upstream from erasing every event it owns, Mailflare keeps the existing set and flags the feed instead.

## Editing and unsubscribing

The pencil button edits the title and refresh interval. The trash button unsubscribes: that removes the feed and deletes every event it imported.

Two things remove feed events, both driven by the feed itself: an event that disappears from the feed's snapshot is pruned on the next successful refresh (the feed is the source of truth for the rows it owns), and unsubscribing deletes the whole set. Fetch failures and the zero-usable-events anomaly above are the exceptions that keep events in place — your own events are never touched either way.

## API

The dialog uses the same routes an API key with the `calendar:read`/`calendar:write` scopes can call; see [API and integrations](api.md#calendar).
