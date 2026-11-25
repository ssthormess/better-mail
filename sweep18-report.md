# Sweep 18 census — base `772753d3`

## Result

No reproducing defect was established in the in-scope surface, so no production fix or regression test was added. The newly introduced API body sites use `.catch(() => null)` and validate through shape-aware parsers before mutation; I did not find a reliable wrong-status/error or destroy-after-write vector from the inspected paths. This is a negative census, not a claim that every reachable flow was exhaustively exercised.

## Site dispositions

| Sites | Disposition / evidence |
|---|---|
| `POST /api/mailboxes/[id]/promotions`, `/api/messages/[messageId]/category`, `/api/subscriptions/preference`, `/api/subscriptions/trash` | **Already-contained**: each catches `request.json()` failures and passes `unknown` into a parser. `parseModeBody`, category/preference parsers and `parseTrashBody` validate object/property types and allowed values before route writes. |
| `GET /api/subscriptions` | **Already-contained**: query values go through `parseOffset`/`parseLimit`; mailbox access and feature mode are checked before listing; missing schema has explicit empty-state handling. |
| Promotions mutation authorization / missing resources | **Already-contained**: `authorizeMutation` checks session and origin; `checkManagedMailbox` checks readable/manageable mailbox and returns 404 when absent. |
| `bulk-mail.ts` | **Deliberately-shaped**: loops over a fixed small `CAMPAIGN_HEADERS` list (three values); header map is supplied by the internal intake call path, not a client request collection. No unbounded send loop is present in this classifier. |
| `promotions/subscriptions-utils.ts` request list handling | **Already-contained**: sender address normalized and limited to 191 chars; `previewOnly` checked as boolean; trash scan is capped at 500 rows and updates chunked at 80. |
| `promotions/subscriptions.ts`, `refile.ts`, `backfill.ts` loops and dates | **Already-contained / internal data**: candidate sets are bounded by query windows/page limits/chunking; timestamps/cursors are DB or scheduler inputs, not raw HTTP date strings. |
| Other new `src/lib/promotions/*` helpers | **Deliberately-shaped**: examined parsing/map-related helpers use explicit fixed enums/typed domain results; no client-controlled `Object.assign`/prototype-sensitive object map read/write found. UI utility date conversion is display-only. |
| New `src/lib/email/{attachment-limits,sender-sweep,shared-file-notice,mail-type-rule}.ts` and modified mail-pipeline files | **Not-request-reachable / internal input** for the specific bug classes searched: these paths are invoked from inbound/outbound processing and do not parse a `Request`; data iteration is based on parsed mail/DB results. No confirmed error-class regression was identified. |
| `src/app/(drive)/drive-upload.ts` | **Cross-domain for this task’s API-parser census**: browser/client upload helper, no server request parser in this helper. No confirmed issue recorded. |

## Reproduction and verification

No fail-before vector was established; consequently there is no claimed fix, payload, or pass-after regression test. `npm ci` completed. Baseline lint/TypeScript commands were attempted before edits; `npm run lint` exceeded the command timeout while running `vp lint`, and `npx tsc --noEmit` also did not complete within the available command window. Thus lint and typecheck counts versus baseline are **undetermined**, not zero. The full `node --test tests/*.test.mjs` suite was not run.

## Overlap union

Queried `gh pr list -R hieunc229/mailflare --state open --limit 100` and retrieved per-PR file lists. No open PR file list intersects the in-scope promotions files or the newly added promotions routes. PR #417 touches shared-file schema/migrations but not this census's `shared-file-notice.ts`. Local `fix/mf-sweep-4..17` diff file lists were compared against the task domain: #4–13 and #14–17 have no in-scope overlap (14–17 are JMAP-only). Mailing-list and vacation-responder feature worktrees were noted; the latter changes `inbound.ts`/`auto-reply.ts`, but is not an open PR file collision and no related hunk was edited.

## Cross-domain findings

No reportable confirmed finding was established in sweep-19-owned files during this scoped review.
