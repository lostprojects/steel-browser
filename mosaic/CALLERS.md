# Browser caller audit, before phase 6 changes

Rungs describe current calls: 1 HTTP, 2 direct agent browser, 3 quiet residential browser. Browser-based callers default to Steel and may fall back to Browserbase unless marked Steel-only; Browserbase may also be selected explicitly by MOSAIC_BROWSER. They do not currently call the service's routing-ladder fetch, so the rung shown is their effective browser choice, not an automatic progression. `residential-US` is a persistent Steel profile, not a throwaway.

| Caller | Current backend; identity; rung/mode | Browser need and fallback |
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
| check_research_tools.py | No browser session; checks local configuration only | No routing or fallback used. Its current Steel readiness check incorrectly requires a local Evomi proxy URL although the service manages proxies. |

Import search: `rg -l 'from browser\\.(bb|bb_session|steel|api) import|from browser import (bb|bb_session|steel|api)|import browser\\.(bb|bb_session|steel|api)' scripts .claude/skills -g '*.py' -g '!*/tests/*'`. Besides the caller rows, it finds browser internals bb.py, bb_session.py, challenge.py and login_codes.py. Kindle imports only browser.mac_focus; check_research_tools reads keys and module availability without importing a browser client.

## Migration results

Service `0684078` deployed on 5 November 2026. The official local MCP SDK passed all eleven tools against production, including scope refusals, PNG and file bytes, an unapproved handoff and a rung-1 markdown fetch. No test sessions remain. An initial fixture assertion expected the page title in readable markdown; extraction removes that title, so the corrected body assertion passed. Caller activation and observation timestamps follow below.
