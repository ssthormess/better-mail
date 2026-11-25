# Sweep 19 census — base `772753d3`

## Outcome
No code fixes were made: the sampled malformed-input paths were already contained, and the task requires a reproducer on the base before changing behavior. No fail-before vector was established, so adding speculative fixes/tests would not meet that requirement. The census is static/targeted source inspection, not a claim that every hostile payload or live deployment was exercised.

## Dispositions
| Surface | Disposition | Evidence / notes |
|---|---|---|
| Public Resend provider-events | already-contained | `provider-events.ts`: size check; Svix failure returns 401; JSON parse returns 400; parsed value is delegated to shape-checking mapper. Handler reads raw text and maps oversized request to 413. |
| Public SES provider-events | already-contained | Size/token/topic/signature checks; JSON parse returns 400; URL parsing is caught and restricted to HTTPS SNS hosts; notification mapper handles untrusted message shape. |
| Resend / SES deliverability feeds | already-contained | Feed verification and validation are in feed libraries; storage/settings parsing is in scope for runtime hardening but no reproducible failure established. |
| Public MTA-STS well-known text route | already-contained | Response-serving path is read-only; stored policy is normalized before use. |
| Deliverability domain, DMARC, alerts, MTA-STS, reports, suppressions, TLS-RPT/TLS, settings APIs | already-contained (auth) | `authorizeDomainAdmin` enforces session, domain-admin permission, mutation origin for writes, and membership in manageable domains; reviewed API routes use this shared authorization. No missing access check identified in the sampled routes. |
| Deliverability report parsing / ingest | already-contained | Report parser has bounded inputs/record processing, catches JSON parsing, and shape-checks nested objects; ingest limits records/rows. Aggregation uses `Map`, not attacker-keyed ordinary objects. |
| DAV route + XML body parser | already-contained | malformed percent-encoding in DAV path is caught and resolves to not-found; body reader limits size; XML parse errors map to 400. Unknown XML properties are escaped in response generation. |
| Takeout calendar / contacts / drive parsers | already-contained (targeted inspection) | CSV/ICS/vCard parsing uses bounded/normalized inputs and downstream shape checks; import folder and file operations are chunked. No proven crash vector found. |
| Contact import stores / calendar import stores / drive import stores | already-contained (targeted inspection) | Store aggregations use Maps/sets in inspected paths; no `__proto__`-style ordinary-object write vulnerability reproduced. |
| App-password routes and utilities | already-contained (existing route tests) | Existing app-password route/util tests present; no new auth gap reproduced in the scoped route review. |
| `server/runtime/fetch-adapter.ts` | already-contained (not malformed parser surface in sampled pass) | No issue established. |

## Auth/access audit
Deliverability APIs centralize authorization through `authorizeDomainAdmin`: session required, `canManageDomains` required, origin validation on writes, and domain ownership/management checked before continuing. Public provider-event/feed routes intentionally have no user session and rely on their signature/token verification. The MTA-STS public text endpoint is intentionally unauthenticated and serves only the published policy.

## Reproduction and validation
No fix was made, therefore there are no fail-before/pass-after payload vectors. Existing relevant suites include `tests/dav-xml.test.mjs`, `tests/dav-handler.test.mjs`, `tests/app-password-route.test.mjs`, and deliverability/parser tests (where present). `npm ci` completed. The first requested lint baseline attempt did not complete within 20 minutes in this shared runner, so lint, TypeScript, and full-suite numbers are unavailable; no code was changed that could introduce regressions.

## Overlap union
- Queried `gh pr list -R hieunc229/mailflare --state open --limit 100`; result included 34 open PRs.
- Queried open-PR changed-file lists; DAV files and `src/lib/auth/app-passwords.ts` / app-password route files overlap open DAV/app-password feature PRs (notably DAV PRs #386–390). Deliverability and provider-event files did not appear in the collected changed-file list.
- Local branches `fix/mf-sweep-4` through `fix/mf-sweep-17` exist in this worktree; no source overlap was taken because this census produced no edits. Sweep-18 is disjoint per task assignment.
