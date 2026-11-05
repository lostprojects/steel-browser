# Phase 6 caller migration

Application `a1da357` is healthy on Railway. Fifteen remote callers have a verified
first run; eight still need one. Their seven-day checks are incomplete, so
Browserbase remains available.

| Commit | Change |
| --- | --- |
| `0684078` | Scoped MCP tools, site defaults in the existing routing table and durable caller outcomes |
| `fcba673` | Bounded summary rates when fallback outcomes are unknown |
| `a1da357` | Overall fetch deadlines, authenticated cancellation and stopped-request replay protection |

The Python client remains `bb.py`/`steel.py`, with `bb_session.py` for the family.
All 23 remote callers carry tags; known sites use the service registry and
multi-site readers retain throwaway sessions. Kindle stays local and the research-
tool checker opens no browser.

## Interface checks

The official local MCP SDK exercised all eleven tools against production,
including 401/403 access controls, protected screenshot refusal and an unapproved
handoff. A separate check delivered identical 135-byte files through the local
Python receiver; local and remote fixtures were removed and sessions released.

On `a1da357`, a 2,000 ms deadline returned HTTP 408 in 2,050 ms. Replaying the same
stopped ID created no new session; the final create count stayed two after the
cancellation and replay checks.

Wrong-owner cancellation left the named agent's request running. Owner
cancellation returned `fetch_cancelled`, and automatic cleanup left zero live
sessions. The updated MCP fetch also returned a validated rung-1 markdown page.

The Python client returned three Utah rows at rung 2 in 2.982 seconds. Its
three-second missing-payload check returned HTTP 408 in 2.924 seconds and left no
live session. Both providers' active-session checks were empty after verification.

## Before-change audit

This table records callers before the migration. Rungs are 1 HTTP, 2 direct agent browser and 3 quiet residential browser. `residential-US` was a persistent Steel profile.

Browser callers defaulted to Steel, with Browserbase available unless marked Steel-only; MOSAIC_BROWSER could select Browserbase explicitly. They did not use the service routing-ladder fetch, so the rung records their effective browser choice.

| Caller | Previous backend; identity; rung/mode | Browser need and fallback |
|---|---|---|
| fetch_news.py (Utah, Arizona, Veridian) | Steel; residential-US; 3 quiet | Search/info reads are fetch candidates; page asset flows need interactions. Browserbase fallback. |
| companies_fetch.py (Bizapedia) | Steel; bizapedia; 3 quiet | Renders results and card DOM; HTML fetch candidate after equivalent validation. Browserbase fallback. |
| aa.py | Steel; residential-US; 3 quiet | Search HTML is a fetch candidate, including legitimate zero-result pages. Direct rung 2 was measured 20/20. Browserbase fallback. Member API download uses direct HTTP. |
| ancestry_com_fetch.py | Steel; ancestry; 3 quiet | Authenticated searches, viewer, downloads require session. Browserbase context ancestry-family fallback. |
| newspapers_fetch.py | Steel; ancestry; 3 quiet | Authenticated session, API, page viewer and downloads require session. Browserbase context ancestry-family fallback. |
| fold3_fetch.py | Steel; ancestry; 3 quiet | Authenticated search and viewer need session; tile transfers may be direct. Browserbase context ancestry-family fallback. |
| maryferrell.py | Steel only; mary-ferrell; 3 quiet | Session required for protected login and PDF. No Browserbase fallback. |
| dtic.py | Steel; throwaway; 2 agent | Direct requests first; browser fallback for live DTIC; rendered HTML may fit fetch. Browserbase fallback. |
| obit.py | Steel; throwaway; 2 agent | Direct/Jina first; fallback rendered HTML could fit fetch. Browserbase fallback. |
| kindle_fetch.py | Local Patchright; local kindle profile; local network | Persistent Kindle reader/login, page turns and OCR; stays local. No Browserbase fallback. |
| fbi.py | Steel; throwaway; 2 agent | Rendered catalog/subject pages are fetch candidates; PDF flow uses same session. Browserbase fallback. |
| crest.py | Steel; throwaway; 2 agent | Uses rendered page and browser context PDF request; initial HTML may fit fetch. Browserbase fallback. |
| aip.py | Steel; throwaway; 2 agent | Viewer state and manifest via page evaluation; session needed for current implementation. Browserbase fallback. |
| yale.py | Steel; throwaway; 2 agent | Interactive search, cookie-carrying document requests; other downloads use direct HTTP. Browserbase fallback. |
| quartex.py | Steel; throwaway; 2 agent | Search, viewer and downloads use page DOM/interaction; browser needed. Browserbase fallback. |
| documentcloud.py | Steel; throwaway; 2 agent | JSON API reads are fetch candidates, subject to content validation. Browserbase fallback. |
| photo.py | Steel; throwaway; 2 agent | PICRYL page inspection extracts source-image URLs, then browser fetches bytes; HTML fetch candidate. Browserbase fallback. |
| archive.py | Steel; throwaway; 2 agent | Shared browser renders multiple archive searches; some pages may fit fetch. Browserbase fallback. |
| dpia.py | Steel; throwaway; 2 agent | Login/forms, search and document interactions require browser; credentials are site-specific. Browserbase fallback. |
| hathitrust.py | Steel; throwaway; 2 agent by default, residential-US/3 quiet with --proxy | Search/query renders page results, read-only parsing candidate for fetch. Browserbase fallback. |
| wayback_bb_fetch.py | Steel; throwaway; 2 agent | Batch-rendered pages; some HTTP reads could fit fetch. Browserbase fallback. |
| wikidata_expand.py | Steel; throwaway; 2 agent for NARA and VIAF | Interactive NARA search plus rendered VIAF; other authority reads use HTTP. Browserbase fallback. |
| imageverify.py | Steel; throwaway; 2 agent | Reverse-search engines and extracted anchors; HTTP/HTML fetch candidate after validation. Browserbase fallback. |
| render_diagram.py | Steel; throwaway; 2 agent | Local render and direct POST tried separately; Kroki GET binary may need browser to clear wall. Browserbase fallback. |
| check_research_tools.py | No browser session; checks local configuration only | No routing or fallback used. Its Steel readiness check required a local Evomi proxy URL although the service manages proxies; this is now corrected. |

Import search: `rg -l 'from browser\\.(bb|bb_session|steel|api) import|from browser import (bb|bb_session|steel|api)|import browser\\.(bb|bb_session|steel|api)' scripts .claude/skills -g '*.py' -g '!*/tests/*'`. Besides the caller rows, it finds browser internals bb.py, bb_session.py, challenge.py and login_codes.py. Kindle imports only browser.mac_focus; check_research_tools reads keys and module availability without importing a browser client.

## First checks and observation windows

Times below are America/New_York. A seven-day window ends at the same local time on 12 November 2026; each still needs normal use and under 10% failure. These are first-run results, not seven-day passes.

| Caller | Verified-run start | First check |
|---|---|---|
| fetch_news.py | 05 Nov 03:51:42 EST | Utah search FOUND, 3 rows; direct agent browser |
| aa.py | 05 Nov 03:54:08 EST | Anna search, 3 parsed rows; direct agent browser |
| newspapers_fetch.py | 05 Nov 03:55:18 EST | validated authenticated search API; ancestry identity |
| fold3_fetch.py | 05 Nov 03:55:35 EST | validated authenticated search API; ancestry identity |
| maryferrell.py | 05 Nov 03:56:14 EST | FOUND, 3 rows; protected Mary Ferrell identity |
| crest.py | 05 Nov 03:56:42 EST | 20 parsed rows |
| documentcloud.py | 05 Nov 03:56:52 EST | structured search API result |
| aip.py | 05 Nov 04:15:30 EST | retry parsed child records; first empty-list success is unverified |
| yale.py | 05 Nov 04:15:10 EST | retry returned nonempty catalog data; first outcome unknown |
| archive.py | 05 Nov 04:05:19 EST | NARA browser result parsed; existing tests passed |
| dpia.py | 05 Nov 04:05:52 EST | parsed search hits |
| quartex.py | 05 Nov 04:27:00 EST | full retry returned parsed search hits; session released; first attempt interrupted |
| imageverify.py | 05 Nov 04:18:33 EST | retry returned parsed reverse-search links; first record unverified |
| render_diagram.py | 05 Nov 04:09:17 EST | valid 1,411-byte generated SVG; scratch removed |
| wayback_bb_fetch.py | 05 Nov 04:19:04 EST | retry captured 1,256 bytes with expected page content; scratch removed |

| Caller | First-run result and remaining work |
|---|---|
| companies_fetch.py | two failures on same Bizapedia identity; quota marker absent; generic error, cause unresolved; successful window pending |
| ancestry_com_fetch.py | initial 0 rows unknown, retry failed after missing result/zero markers; member marker present, no verified payload; successful window pending |
| fbi.py | two failed Vault part-list attempts; no fallback; successful window pending |
| hathitrust.py | first run interrupted; full retry completed BLOCKED at 04:26:34 EST, sessions released; successful window pending |
| obit.py | Legacy browser read failed payload validation; successful window pending |
| photo.py | PICRYL dry run failed; no file or corpus write; successful window pending |
| wikidata_expand.py | NARA browser path failed; no dossier was written; successful window pending |
| dtic.py | browser-path check failed with direct probe bypassed; successful window pending |

The first AIP and image-verification results were transport-only and must not be counted as payload validation. Earlier unknown, failed and interrupted events remain in the service ledger. Filter each observation window from the listed verified-run start; compare failures and fallbacks, and treat unknowns and insufficient normal use as no acceptance.

Browserbase and its existing family context remain available. `check_research_tools.py` passed its configuration-only check; `kindle_fetch.py` stays local. Prior service logs did not identify caller usage, so later callers were checked in the documented runbook order.

Existing tests: fetch_news 10/10, archive 9/9, imageverify 5/5 after final validation change. Collector skill/link checks: 0 problems across the changed procedure files.

A controlled UDN nonsense query after the validator change was interrupted after 19 minutes on 05 Nov at 09:50:57 UTC; the service recorded a failure and its remaining session was released. A separate direct validation probe reported payload_missing on Steel and Browserbase. Neither establishes a valid zero result. The service summary last recorded a UDN outcome at 09:51:17.787 UTC; its verified rung 2 policy was restored after the attempt.

## Validation and delivery

TypeScript passed. Existing service files passed 47 checks across session pool,
routing, file headers and vault login. Mosaic's final existing caller files
passed 10 news, 9 archive and 5 image-verification tests.

The source registry contains 317 unique entries, and collector procedure/link
checks passed. Later callers were checked in the runbook order because earlier
service logs had no caller tags from which to establish usage order.

The site registry uses `/data/routing/routes.json`. Admin
`GET /v1/caller-outcomes` reads metadata by caller and UTC day, with session end
reasons and fallback counts.

Each Browser context reports a caller run; `fetch_page` reports one validated
read. A successful transport alone leaves its payload unverified, and a failed
validation remains failed for that run. Unacknowledged metadata syncs from
Mosaic's `.state/browser-outcomes.jsonl`; the queue was empty after checks.

Remote cleanup now releases the browser before stopping the local CDP driver.
A stalled Quartex interruption exposed the previous order; subsequent new-process
checks completed and released normally.

MCP downloads return a session-scoped file. The local command
`steel.py --receive-download SESSION_ID --file FILE_NAME` saves it in Mosaic's
INBOX without overwriting an existing file; `--out` selects another directory.

## Timeout incident and resolution

The controlled Utah empty-result query did not establish a valid zero result.
Its actual caller ran beyond 19 minutes and continued service retries; the run
was interrupted, its remaining session released, and its failed outcome retained.

Commit `a1da357` now applies one service deadline to the routing ladder. A client
uses a stable request ID, bounds its complete HTTP exchange in an on-demand
worker, and cancels unfinished service work before fallback or interruption.

Stopped IDs cannot restart for ten minutes, including through dropped failed
idempotency entries. Late launches release as soon as they resolve. The production
checks above verified those controls; they do not establish Utah's zero-result
payload support, which remains unresolved.

The verified Utah policy remains rung 2 with its measured split policy preserved.
No Browserbase code, account, contexts or environment keys were removed.
Retirement awaits every caller's week, including successful checks for the eight
pending callers and resolution of unverified payload behavior.
