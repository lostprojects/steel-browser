# Caller migration evidence

Twenty-one remote callers have verified payloads; DTIC and HathiTrust lack
verified browser runs. Every seven-day window is open and normal-use sufficiency
is unestablished. Browserbase remains available. Application `4bf8e12` is healthy
on Railway; its real Utah caller verified an explicit zero-result payload.
Acceptance and follow-up work are maintained in
[TOOLSTACK-PLAN.md](../TOOLSTACK-PLAN.md#caller-review-and-browserbase-retirement).

| Commit | Change |
| --- | --- |
| `0684078` | Scoped MCP tools, site defaults in the existing routing table and durable caller outcomes |
| `fcba673` | Bounded summary rates when fallback outcomes are unknown |
| `a1da357` | Overall fetch deadlines, authenticated cancellation and stopped-request replay protection |
| `4bf8e12` | Accept verified Utah empty-search markup outside the result table |

The Python client remains `bb.py`/`toolstack.py`, with `bb_session.py` for the family.
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

This table records callers before the migration. Rungs are 1 HTTP, 2 direct agent browser and 3 quiet residential browser. `residential-US` was a persistent Toolstack profile.

Browser callers defaulted to Toolstack, with Browserbase available unless marked Toolstack-only; MOSAIC_BROWSER could select Browserbase explicitly. They did not use the service routing-ladder fetch, so the rung records their effective browser choice.

| Caller | Previous backend; identity; rung/mode | Browser need and fallback |
|---|---|---|
| fetch_news.py (Utah, Arizona, Veridian) | Toolstack; residential-US; 3 quiet | Search/info reads are fetch candidates; page asset flows need interactions. Browserbase fallback. |
| companies_fetch.py (Bizapedia) | Toolstack; bizapedia; 3 quiet | Renders results and card DOM; HTML fetch candidate after equivalent validation. Browserbase fallback. |
| aa.py | Toolstack; residential-US; 3 quiet | Search HTML is a fetch candidate, including legitimate zero-result pages. Direct rung 2 was measured 20/20. Browserbase fallback. Member API download uses direct HTTP. |
| ancestry_com_fetch.py | Toolstack; ancestry; 3 quiet | Authenticated searches, viewer, downloads require session. Browserbase context ancestry-family fallback. |
| newspapers_fetch.py | Toolstack; ancestry; 3 quiet | Authenticated session, API, page viewer and downloads require session. Browserbase context ancestry-family fallback. |
| fold3_fetch.py | Toolstack; ancestry; 3 quiet | Authenticated search and viewer need session; tile transfers may be direct. Browserbase context ancestry-family fallback. |
| maryferrell.py | Toolstack only; mary-ferrell; 3 quiet | Session required for protected login and PDF. No Browserbase fallback. |
| dtic.py | Toolstack; throwaway; 2 agent | Direct requests first; browser fallback for live DTIC; rendered HTML may fit fetch. Browserbase fallback. |
| obit.py | Toolstack; throwaway; 2 agent | Direct/Jina first; fallback rendered HTML could fit fetch. Browserbase fallback. |
| kindle_fetch.py | Local Patchright; local kindle profile; local network | Persistent Kindle reader/login, page turns and OCR; stays local. No Browserbase fallback. |
| fbi.py | Toolstack; throwaway; 2 agent | Rendered catalog/subject pages are fetch candidates; PDF flow uses same session. Browserbase fallback. |
| crest.py | Toolstack; throwaway; 2 agent | Uses rendered page and browser context PDF request; initial HTML may fit fetch. Browserbase fallback. |
| aip.py | Toolstack; throwaway; 2 agent | Viewer state and manifest via page evaluation; session needed for current implementation. Browserbase fallback. |
| yale.py | Toolstack; throwaway; 2 agent | Interactive search, cookie-carrying document requests; other downloads use direct HTTP. Browserbase fallback. |
| quartex.py | Toolstack; throwaway; 2 agent | Search, viewer and downloads use page DOM/interaction; browser needed. Browserbase fallback. |
| documentcloud.py | Toolstack; throwaway; 2 agent | JSON API reads are fetch candidates, subject to content validation. Browserbase fallback. |
| photo.py | Toolstack; throwaway; 2 agent | PICRYL page inspection extracts source-image URLs, then browser fetches bytes; HTML fetch candidate. Browserbase fallback. |
| archive.py | Toolstack; throwaway; 2 agent | Shared browser renders multiple archive searches; some pages may fit fetch. Browserbase fallback. |
| dpia.py | Toolstack; throwaway; 2 agent | Login/forms, search and document interactions require browser; credentials are site-specific. Browserbase fallback. |
| hathitrust.py | Toolstack; throwaway; 2 agent by default, residential-US/3 quiet with --proxy | Search/query renders page results, read-only parsing candidate for fetch. Browserbase fallback. |
| wayback_bb_fetch.py | Toolstack; throwaway; 2 agent | Batch-rendered pages; some HTTP reads could fit fetch. Browserbase fallback. |
| wikidata_expand.py | Toolstack; throwaway; 2 agent for NARA and VIAF | Interactive NARA search plus rendered VIAF; other authority reads use HTTP. Browserbase fallback. |
| imageverify.py | Toolstack; throwaway; 2 agent | Reverse-search engines and extracted anchors; HTTP/HTML fetch candidate after validation. Browserbase fallback. |
| render_diagram.py | Toolstack; throwaway; 2 agent | Local render and direct POST tried separately; Kroki GET binary may need browser to clear wall. Browserbase fallback. |
| check_research_tools.py | No browser session; checks local configuration only | No routing or fallback used. Its Toolstack readiness check required a local Evomi proxy URL although the service manages proxies; this is now corrected. |

Import search: `rg -l 'from browser\\.(bb|bb_session|toolstack|api) import|from browser import (bb|bb_session|toolstack|api)|import browser\\.(bb|bb_session|toolstack|api)' scripts .claude/skills -g '*.py' -g '!*/tests/*'`. Besides the caller rows, it finds browser internals bb.py, bb_session.py, challenge.py and login_codes.py. Kindle imports only browser.mac_focus; check_research_tools reads keys and module availability without importing a browser client.

## First checks and observation windows

All timestamps below are UTC. End times are exclusive. The initial fifteen
windows close early on 12 November EST; the six later windows close that afternoon.
These are first verified payloads, not seven-day passes.

| Caller | Window start UTC | Window end UTC | Verified payload |
|---|---|---|---|
| fetch_news.py | 2026-11-05T08:51:42Z | 2026-11-12T08:51:42Z | Utah search FOUND, 3 rows; direct agent browser |
| aa.py | 2026-11-05T08:54:08Z | 2026-11-12T08:54:08Z | Anna search, 3 parsed rows; direct agent browser |
| newspapers_fetch.py | 2026-11-05T08:55:18Z | 2026-11-12T08:55:18Z | validated authenticated search API; ancestry identity |
| fold3_fetch.py | 2026-11-05T08:55:35Z | 2026-11-12T08:55:35Z | validated authenticated search API; ancestry identity |
| maryferrell.py | 2026-11-05T08:56:14Z | 2026-11-12T08:56:14Z | FOUND, 3 rows; protected Mary Ferrell identity |
| crest.py | 2026-11-05T08:56:42Z | 2026-11-12T08:56:42Z | 20 parsed rows |
| documentcloud.py | 2026-11-05T08:56:52Z | 2026-11-12T08:56:52Z | structured search API result |
| aip.py | 2026-11-05T09:15:30Z | 2026-11-12T09:15:30Z | retry parsed child records; first empty-list success is unverified |
| yale.py | 2026-11-05T09:15:10Z | 2026-11-12T09:15:10Z | retry returned nonempty catalog data; first outcome unknown |
| archive.py | 2026-11-05T09:05:19Z | 2026-11-12T09:05:19Z | NARA browser result parsed; existing tests passed |
| dpia.py | 2026-11-05T09:05:52Z | 2026-11-12T09:05:52Z | parsed search hits |
| quartex.py | 2026-11-05T09:27:00Z | 2026-11-12T09:27:00Z | full retry returned parsed search hits; session released; first attempt interrupted |
| imageverify.py | 2026-11-05T09:18:33Z | 2026-11-12T09:18:33Z | retry returned parsed reverse-search links; first record unverified |
| render_diagram.py | 2026-11-05T09:09:17Z | 2026-11-12T09:09:17Z | valid 1,411-byte generated SVG; scratch removed |
| wayback_bb_fetch.py | 2026-11-05T09:19:04Z | 2026-11-12T09:19:04Z | retry captured 1,256 bytes with expected page content; scratch removed |
| companies_fetch.py | 2026-11-05T17:19:30.596935Z | 2026-11-12T17:19:30.596935Z | Three officer/company cards after selector correction; subsequent company grab verified five filing-field markers. |
| ancestry_com_fetch.py | 2026-11-05T17:10:03.893000Z | 2026-11-12T17:10:03.893000Z | Three WWI draft records on ancestry. Start is the first verified session settlement; later general-search failure remains in this window. |
| fbi.py | 2026-11-05T17:09:28.027499Z | 2026-11-12T17:09:28.027499Z | UFO list returned all 16 parts after /view normalization. |
| wikidata_expand.py | 2026-11-05T17:15:12.671537Z | 2026-11-12T17:15:12.671537Z | NARA rendered search returned three NAID/title rows, total 61,261; no dossier write. |
| photo.py | 2026-11-05T17:17:50.680635Z | 2026-11-12T17:17:50.680635Z | PICRYL dry run verified a 231,552-byte JPEG in memory; quiet US route; no attachment. |
| obit.py | 2026-11-05T17:19:09.389786Z | 2026-11-12T17:19:09.389786Z | Legacy returned a complete 1,715-byte JSON-LD obituary; quiet US route. |

| Caller awaiting a window | Current blocker |
|---|---|
| dtic.py | Public source unavailable: official DTIC notices and local/Toolstack responses agree on maintenance. Mirror search and citation work independently; they cannot start a browser window. Live access is now lazy after a mirror miss or PDF failure. The browser validator requires the requested accession. |
| hathitrust.py | Remote search is challenged before a source payload. The identical query works anonymously in local Chrome, including a zero control and page-number lookup inside a copyrighted volume. Local UI access and catalog API results cannot start its remote window. Protected Google login was untouched. |

The first AIP and image-verification results were transport-only and must not be counted as payload validation. Earlier unknown, failed and interrupted events remain in the service ledger. Filter each observation window from the listed verified-run start; compare failures and fallbacks, and treat unknowns and insufficient normal use as no acceptance.

Browserbase and its existing family context remain available. `check_research_tools.py` passed its configuration-only check; `kindle_fetch.py` stays local. Prior service logs did not identify caller usage, so later callers were checked in the documented runbook order.

Existing tests: fetch_news 10/10, archive 9/9, imageverify 5/5 after final validation change. Collector skill/link checks: 0 problems across the changed procedure files.

A controlled UDN nonsense query after the validator change was interrupted after 19 minutes on 05 Nov at 09:50:57 UTC; the service recorded a failure and its remaining session was released. A separate direct validation probe reported payload_missing on Toolstack and Browserbase. Neither establishes a valid zero result. The service summary last recorded a UDN outcome at 09:51:17.787 UTC; its verified rung 2 policy was restored after the attempt.

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
`toolstack.py --receive-download SESSION_ID --file FILE_NAME` saves it in Mosaic's
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
checks above verified those controls. The separate production check below now
verifies Utah's zero-result payload.

The verified Utah policy remains rung 2 with its measured split policy preserved.
No Browserbase code, account, contexts or environment keys were removed.
No Browserbase retirement is supported by these measurements.

## Follow-up diagnostics, 5 November

Earlier failed, unknown and interrupted events remain in the ledger. Diagnostics
use `phase6-diagnostic.*` tags and are excluded from the caller windows above.
The first two Bizapedia results in this follow-up were navigation-only and cannot
establish payload success despite their old validator's success flag. Its window
starts with the corrected card parser. No historical ledger rows were rewritten.

- Bizapedia renders `a.people-card-link` company cards with state-code company URLs.
  The old selector returned state navigation, and grab accepted “Add My Company”.
  Search now returns cards; grab requires a company link or multiple filing labels.
- Ancestry's general search displayed 40 member-photo rows and no indexed-record
  links. It now follows the displayed record categories with the same filters.
  A real retry returned three census records. The earlier general-search failure
  remains inside the original verified window; its start was not moved.
- FBI's Plone `/view` links were rejected before normalization. Its corrected
  ordinary list returned all 16 UFO parts. A separately tagged download diagnostic
  verified Part 01 as a 7,508,456-byte PDF, held only in memory.
- NARA's old proxy URL returns an HTML application shell. Its browser caller now
  validates the rendered catalog result count and NAID/title rows. The UI supplies
  no `recordType`, so that field remains null. VIAF was not exercised.
- PICRYL now reads DOM image metadata, builds size URLs correctly and validates
  downloaded image bytes even in a dry run. Legacy validates its obituary DOM
  after challenge handling, since the initial status can remain 403. Both hosts
  failed on fresh direct access and passed a tagged quiet US diagnostic, then
  passed their real caller paths with host policies set to quiet, US, identity null.
  `picryl.com`, `www.picryl.com`, `legacy.com` and `www.legacy.com` retain split=false.
  No account login or protected profile was used for those sources. GetArchive
  was not exercised.

Utah's genuine zero-result page returns HTTP 418 with the Utah title and an `h5`
“No results found for” heading followed by `ul.suggest`; it has no result table.
The service, Browserbase fallback validator and collector now recognize that
specific markup. The earlier prolonged failed caller remains recorded.

After flushing metadata (pending zero), all 21 exact seven-day ranges were queried
through `toolstack.py --outcomes --from START --to END`. After the Utah production
check on 5 November, fetch_news and Ancestry were each 1 failedOrFallback / 3
attempts (33.3%). Other started windows had zero failedOrFallback with only 1–4
attempts each. All selected windows had zero unknowns, but every window was still
open and normal-use sufficiency was unestablished. None passed acceptance.

Focused checks passed: news 10, acquisition 3, photo 21 and service routing 5.
TypeScript and syntax checks for the ten changed Python files passed. Collector
procedure checks found zero problems. No corpus records or source files were
written by these diagnostics.

## Production verification and delivery

Railway deployed `4bf8e12` successfully on 5 November. The normal
`fetch_news.udn_search` call for `qxzvplmnytr8nonexistent` ran from
18:21:56.233517 to 18:21:57.816632 UTC and returned `ZERO_RESULTS`, total 0,
shown 0. Its real caller outcome was successful with no fallback, zero residential
bytes and a released session. Health was OK, the pool empty and pending metadata
zero afterward. Utah's original failed run remains inside its original window.

The final public HathiTrust challenge-helper probe reported CLEARED on the
`residential-US` profile without reading a source payload, so its separately
tagged outcome remains unknown. The ordinary caller's supported `--proxy` retry
used its configured unnamed profile and still returned BLOCKED at
18:07:37.788451 UTC. It cannot inherit clearance from the other profile, and
neither result starts its window. No protected Google login was attempted.

Before the application push, the pool was empty and the preceding ten minutes
contained no collector requests. `rw logs --http --since 10m` currently returns
older HTTP rows too; its HTTP implementation ignores the parsed start time.
Use the requested command with `--limit 1000 --format json`, then filter its UTC
`time` values to the actual ten-minute interval. Check that the returned rows
cover that interval, and exclude only administrative reads when deciding whether
collector traffic is absent. Keep keys and query strings out of diagnostic output.

Both branches were pushed together with `git push origin main main:deploy` after
pulling with rebase. The documentation-only follow-up does not need a service
restart. No account, context or environment key was removed.

## Source diagnosis, 5 November

The owner reports the same DTIC and HathiTrust failures through Browserbase.
The checks below distinguish source availability from remote-browser access;
they do not establish that Toolstack passes either caller's acceptance window.

DTIC's [Technical Reports](https://discover.dtic.mil/technical-reports/) and
[Products & Services](https://discover.dtic.mil/products-services/) pages report
public search offline. The former still documents `apps.dtic.mil/sitemap.xml`;
neither announces a replacement public endpoint or permanent retirement.
The separately controlled R&E Gateway has its own eligibility requirements.

The actual caller's citation request redirected to `/landingpage/maint.html`
at 21:36:15 UTC, HTTP 200 with 1,408 wire bytes. Toolstack reached that same page at
21:36:48 UTC, HTTP 200 with 1,352 rendered HTML bytes. Direct requests for the
report PDF and official sitemap also returned maintenance at 21:39:46 UTC.
The internal cause and restoration date remain unknown.

DTIC now resolves mirror metadata before starting live access, opens a browser
only after HTTP needs it, and repairs the skipped live-PDF path when direct
metadata succeeds without a browser or a mirror PDF fails. A normal citation
rerun resolved AD0688332's 417-page metadata through one IA request and zero
live requests. The repaired live-PDF path still needs a real PDF after service
restoration. Mirror success cannot substitute for its browser observation week.

HathiTrust's remote residential browser returned Cloudflare verification for
both the Babel homepage and the exact `Uhouse` search URL. Local direct HTTP
also received a Cloudflare 403. Local Chrome served that same search anonymously
with 317 items, 86 Full View, and a genuine zero for `Uhouse Qxzjkl`.
The local item UI also found one `Uhouse` match at scan 384, printed page 52,
inside copyrighted volume `uva.x002460967`, without login.

This isolates a remote-access problem before the search payload. It does not
identify the decisive IP, browser or session signal. HathiTrust's
[access policy](https://hathitrust.atlassian.net/wiki/spaces/GS/pages/2387247137)
allows anonymous search-within page numbers; member login does not generally
unlock copyrighted text. The old partner-login explanation has been removed.
The collector now reports specific block reasons and stops on explicit refusal;
the procedure uses the existing local UI when remote access is challenged.

A tagged check of the revised HathiTrust caller from 21:42:56 to 21:43:06 UTC
returned `BLOCKED`, HTTP 403, `block_reason: cloudflare_challenge`, and released
the session. Source detail stays in caller output; service metadata uses its
existing reason vocabulary. Its outcome remains failed. The earlier
`source-diagnostic.hathitrust-access` probe remains unknown because it inspected
access responses without validating a search result.

The DTIC diagnostic's unsupported queued reason `source_maintenance` was changed
to the supported `payload_missing` before delivery, preserving its failed
outcome and timestamp. The queue then flushed completely, including unrelated
waiting outcomes. No historical failure was removed or relabelled as success.

Syntax, catalog metadata retrieval and collector procedure checks passed; neither
changed collector has an existing matching test file. No protected login, human
handoff or corpus write was used. Neither caller has a remote observation start;
the 21 existing windows and retirement requirements remain unchanged.
