# Design: Mosaic's browser service

Written 3 November 2026. The owner has decided to adapt this Steel fork into Mosaic's own browser service while retaining Browserbase temporarily until phase 6 moves the callers. This document sets out that design. [REVIEW.md](REVIEW.md) holds the evidence behind it; its recommendation to replace Steel is superseded.

## Aim

Give Mosaic's agents a browser they can use freely, quickly and without fuss, from one service on Railway. One kind of session is fast and fully instrumented for ordinary sites. The other is quiet enough for sites behind Cloudflare, DDoS-Guard and logins. Both draw on shared infrastructure:

- a pool of browsers
- stored identities and a vault for logins
- residential proxies
- one interface for agents

## What we keep from Steel, and what we change

| Keep | Change |
|---|---|
| The commands engine: page snapshots with element refs, batched actions, masking of password fields in snapshots (`services/commands/`, about 11,700 lines with tests) | Make it serve many sessions, and add a quiet policy (below) |
| Scrape to markdown and readability, screenshots, PDFs, PDF-to-HTML (`modules/actions`, `utils/scrape`) | Keep for agent sessions |
| The CDP WebSocket pass-through, the API key, the live view, the files API, the plugin hooks | Pass-through and key stay; the live view gains noVNC for quiet sessions |
| The proxy-chain forwarder with byte counts (`utils/proxy.ts`) | Becomes part of a proxy manager with budgets |
| All the stealth tuning in `STEALTH.md` | Moves from Railway variables into the quiet session's launch profile |
| The singleton `CDPService` and `SessionService` | **Replaced** by a session pool |
| Debian `chromium`, installed unpinned | **Replaced** by Google Chrome stable at a recorded version |
| Fingerprint injection, Selenium mode, the idle browser | **Removed** |

From here on, the fork is our product. Rewriting most of Steel is acceptable. Keep a Steel part only while it serves the aim, and rewrite or delete it when it gets in the way. Take upstream fixes by cherry-picking them, and stop merging `upstream/main` wholesale. Keep Steel's Apache 2.0 licence and notices.

## Shape

```
agents (MCP over HTTP)  ─┐
Mosaic scripts (Python) ─┼─►  API + MCP  ─►  Session pool ──► Chrome process per session
noVNC (the owner)       ─┘        │              │               (own Xvfb display, own profile dir)
                                  │              ├─ commands engine (agent or quiet policy)
                                  │              └─ forwarder per session ─► Evomi
                                  ├─ Profiles   (volume: /data/profiles)
                                  ├─ Vault      (volume: /data/vault, encrypted)
                                  ├─ Proxies    (providers, sticky sessions, budgets)
                                  └─ Log        (one JSON line per session)
```

The owner selected `MAX_SESSIONS=3` and a default daily residential budget of 1 GB per agent key.

One Railway service with one volume. A deploy causes a brief outage because Railway runs no overlap with a volume attached, so deploys come from a `deploy` branch and wait for running sessions (below).

## Two session modes

A session's mode is fixed when it is created. A site registry chooses the default, and an agent can ask for the other mode explicitly.

| | Agent mode | Quiet mode |
|---|---|---|
| For | Ordinary sites, search pages, documentation, fast reading | Cloudflare, DDoS-Guard, Bizapedia, Anna's Archive, Ancestry, Newspapers.com, Fold3 |
| Browser | Chrome, headless allowed for speed | Chrome headful on Xvfb with the `STEALTH.md` flags |
| Network | Railway's own IP by default; residential on request | Residential, one sticky exit per session |
| Server instrumentation | Full: logs, request capture, scrape and screenshot actions | None on pages: no `Runtime`, `Log` or console domains, no request interception, no recorder |
| Page reading | Commands engine in the page's main world | Commands engine in an isolated world |
| Input | CDP `Input` events | X11 events on the session's display (`xdotool`), with curved pointer paths |
| Screenshots and video | CDP | From the X display (`ffmpeg x11grab`) |
| Profile | Throwaway | Throwaway, or a named identity |

### The quiet policy

The engine's page calls are mostly `Runtime.callFunctionOn`, `DOM.*`, `Accessibility.get*AXTree` and `Input.dispatch*`, which are easy to audit. The quiet policy changes three things:

1. **Isolated world.** Every function the engine runs goes into an isolated world created per frame (`Page.createIsolatedWorld`, then `DOM.resolveNode` with that world's context). It never runs in the main world, and `Runtime.enable` is never sent.
2. **X11 input.** Clicks and typing go to the X server. A CDP click inside a cross-origin iframe reports wrong `screenX`/`screenY`, which Turnstile reads ([WebScraper.io, 24 Oct 2025](https://webscraper.io/blog/google-patches-100-precise-cloudflare-turnstile-bot-check)). An X11 click is real input.
3. **No page-level listeners.** The session never attaches Steel's target instrumentation. It also stops the auto-attach that pauses new targets.

Whether reading the accessibility tree can be seen from a page is unknown. Measure it with the commands engine running a full snapshot during the bot tests. If any test flags it, quiet sessions fall back to reading through the isolated world only.

## Shared infrastructure

### Session pool

This replaces the singleton. `BrowserSession` owns one Chrome process, one Xvfb display, one profile directory, one forwarder and, in agent mode, one Puppeteer connection. `SessionPool` creates, finds and ends sessions by ID.

- `MAX_SESSIONS` limits concurrency. Above the limit, new requests wait in a short queue, then get 429.
- A session ends on release, after an idle timeout (no client for 10 minutes), at a lifetime cap (3 hours), or when Chrome exits. The client sees the reason.
- Throwaway profiles are deleted at the end of the session.
- On SIGTERM, the pool stops accepting sessions and waits up to `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. It then closes Chrome normally so profiles flush to disk.
- Chrome is started without Puppeteer in quiet mode (a plain child process with `--remote-debugging-port` on 127.0.0.1). The engine then connects through a CDP connection that enables only what the quiet policy needs.

There are about 90 references to `cdpService` and `sessionService` across 16 files. The commands engine already takes per-session callbacks (`browser()`, `released(id)`, `endSession(id)`), so it needs the least change.

### Identities (named profiles)

An identity is a named Chrome profile on the volume plus a small record:

| Field | Example |
|---|---|
| `name` | `ancestry` |
| `sites` | ancestry.com, newspapers.com, fold3.com |
| `mode` | quiet |
| `exit` | Evomi Core, US, one fixed state, its own sticky session ID |
| `timezone`, `locale` | Taken from the exit, checked on every start |
| `vault` | `ancestry` |
| `last_exit_ip`, `last_login_ok` | Updated each session |

Only one session can hold an identity at a time; a second request gets 409. If the exit IP changes during a session, the session restarts with the new timezone, because `TZ` is fixed when Chrome starts.

### Vault

The vault holds site logins, two-factor seeds and the proxy providers' credentials. Agents refer to entries by name and never receive the values.

- **Storage:** one AES-256-GCM encrypted file on the volume, using Node's own `crypto`. The key is a Railway variable, `VAULT_KEY`, kept in `global.env` and Mosaic's `.env` like the other credentials. There is no external dependency.
- **API:** write values with `PUT /v1/vault/{name}`. `GET` returns names, fields and last-use times, never values.
- **Use:** `login {identity}` runs a stored login flow for that site. The engine finds the fields in the isolated world, focuses them, and types the values through X11 in quiet mode or CDP in agent mode. A TOTP code is generated at the moment of use. Email and SMS code fields can issue a short-lived request to a local agent. Under the owner’s standing permission, that agent uses the code-only Apple Mail or Messages helper for the current site and account; the service consumes the code on the same login URL. Other device and Google checks retain their classified result; human involvement requires the owner’s agreement.
- **Leaks:** the engine's existing masking hides password fields in snapshots. Vault values are also scrubbed from every response and log line.
- **Audit:** every use is logged with the session, the agent's key and the site.

The Ancestry email and password move from Mosaic's `.env` into the vault.

### Proxies

The proxy manager owns the provider list (Evomi Core as the default, Evomi Premium in reserve) and hands each session an exit:

- **Sticky sessions.** It allocates sticky session IDs: a new one per throwaway session, and a fixed one per identity.
- **Exit check.** Before Chrome starts, it looks up the exit IP, region and timezone through the exit itself, always with the same geolocation service. Optionally it records a TCP operating-system guess.
- **Byte metering.** It counts bytes per session, per agent key and per day. Budgets apply per agent and per day; a session over budget is ended with a clear reason.
- **Retries.** A challenged quiet session retries once on a new exit before failing.
- **Bad exits.** It keeps a short per-site list of exits that failed, so the same IP is not reused at once.

### Routing and bandwidth

Residential traffic is cheap for pages and expensive for files and media. A collector page is 117 KB to 1 MB (`STEALTH.md`), so 1,000 pages cost about 50 cents through Evomi Core. A single newspaper or census scan can cost as much as hundreds of pages. Spend residential bytes only where a site checks the IP, and send everything else direct from Railway.

**Choose the cheapest route that works, and remember it.** Each request climbs a ladder and stops at the first rung that returns real content:

| Rung | Route | Cost |
|---|---|---|
| 1 | Plain HTTP from Railway, with Chrome's TLS fingerprint (`curl_cffi` or `curl-impersonate`), no cookies | Almost nothing |
| 2 | Agent-mode browser from Railway | Railway compute only |
| 3 | Quiet browser on a residential exit | Evomi bytes |

The probe at rung 1 is the "sniffer". It reads the response for challenge markers before anything is spent:

- a `cf-mitigated` header, or a Cloudflare 403 or 503
- DDoS-Guard's `__ddg` cookies or challenge page
- `Just a moment`, `Human Verification`, HTTP 418 or 429
- a page that is valid HTML but lacks the route's payload, such as Bizapedia's silent empty result

Validate content, never status alone. Utah Digital Newspapers can send HTTP 418 with a valid page (`fetch_news.py`).

A per-host routing table records the lowest rung that worked, with a 7-day expiry, and moves a host up a rung after a failure. Hosts the collector has already measured start where the evidence puts them:

| Host | Start at | Evidence |
|---|---|---|
| Ancestry, Newspapers.com, Fold3 after login | 3 | Keep authenticated pages and API requests on the identity’s fixed residential allocation, using the same egress as login |
| Ancestry-family sign-in | 3 | The device check is the step a residential IP helps (`ancestry_com_fetch.py`) |
| Bizapedia | 3 | 0 of 3 on datacenter egress, 3 of 3 residential (`companies_fetch.py`, 20 Aug 2026) |
| Anna's Archive | 2, then 3 | The latest 20-search acceptance passed directly in 20/20 with zero residential bytes; residential escalation remains available (`STEALTH.md`) |
| Utah Digital Newspapers | 1, then measure | Uses residential today with no recorded reason |

Railway's addresses have a different reputation from Browserbase's, so re-measure every start rung once on Railway.

Never probe with an identity's cookies. A logged-in request from a second IP is the pattern a site's fraud checks look for.

**Inside a quiet session, split traffic by host at the forwarder.** The forwarder sees each CONNECT hostname without decrypting anything, so it can route per host:

- **Residential:** the target's own domains, the CDNs it serves from, and challenge providers such as `challenges.cloudflare.com` and DDoS-Guard's hosts. These must share one exit, because clearance cookies are tied to the visitor ([Cloudflare docs, 23 Oct 2026](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)).
- **Direct:** a curated list of public static CDNs (Google Fonts, cdnjs, jsdelivr, unpkg). The target never sees those connections.
- **Refused:** ad, video and tracking hosts that are never challenge providers.
- **Unknown hosts** stay residential and are logged with their bytes, so the lists grow from data.

Splitting traffic, or refusing it, is a change from an ordinary browser, so measure both with the bot tests before turning them on for a site.

**Fetch signed CDN files direct.** A recognized CDN URL carrying a signature may use Railway direct, with a residential fallback. Other authenticated files use the identity’s egress. Mosaic already does this for signed asset URLs because "a signed CDN URL is authenticated by its signature, not by the egress IP" (`bb_session.py`). Downloads are the largest bytes Mosaic moves, so this saves the most.

**Keep media off the meter.** Quiet sessions run with `--autoplay-policy=user-gesture-required`. Agent sessions may also block images and media, since nothing is watching them.

**Watch the numbers.** The session log records bytes per host and per route. Report a host whose residential bytes jump, and end a session that streams for minutes without a navigation.

### Hand-off to a person

The service performs logins from the vault. It answers machine-readable device checks when the necessary vault entry exists and reports the exact missing access otherwise. Protected identities refuse noVNC and image capture because those paths can expose credentials. A request for human help requires the owner’s agreement.

### Access and observability

- **API keys.** One named key per agent or script, each scoped to identities, vault entries and a byte budget. The current single `STEEL_API_KEY` becomes the admin key.
- **Session log.** One JSON line per session: mode, identity, exit IP and region, Chrome version, bytes, duration, end reason, challenge outcome.
- **Recording.** In quiet mode, record the last two minutes of video from the X display and keep it only when the job fails.
- **Health.** `/health` reports the Chrome version, live sessions, free memory and vault status (locked or open).
- **Canary.** A weekly cron service runs the probe and three routes. It needs an entry in Mosaic's `.claude/infrastructure.md`.

## The agent interface

The service serves an MCP endpoint over HTTP with the same key. Any Mosaic agent, local or in the cloud, can use it without a local browser. Mosaic's Python scripts use the existing `scripts/browser/bb.py` and `steel.py` as the thin client over the same API. Phase 6 extends those modules and avoids a parallel `remote.py`.

| Tool | Does |
|---|---|
| `browser_open(site or url, identity?, mode?, residential?)` | Starts a session using the site registry's defaults |
| `browser_snapshot(session)` | Page outline with element refs (commands engine) |
| `browser_act(session, commands)` | Batched navigate, click, type, select, scroll, wait |
| `browser_read(session, format)` | The page as markdown, readable text or HTML |
| `browser_screenshot(session)` | An image of the page or the display |
| `browser_download(session, ref or url)` | Saves the file and returns it to Mosaic's INBOX path through the files API |
| `browser_login(session, identity)` | Runs the vault login flow |
| `browser_handoff(session, reason)` | Returns a noVNC link for the owner and waits |
| `browser_network(session)` | Recent requests (agent mode only) |
| `browser_close(session)` | Ends the session and reports bytes and cost |
| `fetch(url, residential?)` | One page, no interaction: open, read as markdown, close |

`fetch` is the fast path for most research reads.

## Build plan

Each phase ends with a check. The current service keeps running throughout as the working fallback.

| Phase | Work | Check |
|---|---|---|
| 0 | Watch paths that skip documentation, deploy from `deploy`, draining time, `blockAds: false` in clients | A docs push deploys nothing |
| 1 | Session pool replacing the singleton; per-session profile directories; timeouts; identity locks; volume | Three sessions at once; a throwaway profile is gone after release; an identity survives a deploy; a second claim on it gets 409 |
| 2 | Google Chrome at a pinned version; one Xvfb display per session; noVNC | `/health` shows the version; fingerprint marks in `REVIEW.md` §6 met |
| 3 | Quiet mode: Chrome started without Puppeteer; engine with isolated world and X11 input | Bot tests clean with a full snapshot and a click running; six routes at `REVIEW.md` §6 marks |
| 4 | Proxy manager: exits, exit checks, metering, budgets, retry; the routing ladder and per-host table; per-host split at the forwarder; direct file fetch with session cookies | Timezone matches the exit in 20 of 20; budgets end a session; retry recovers Anna's Archive; each collector route settles on its cheapest rung with the same pass rate; residential bytes per route fall by at least half with no drop in pass rate |
| 5 | Vault, login flows, TOTP, hand-off | Vault login passed 5 November 2026. Authenticated daily jobs observe the existing Ancestry identity from 5–12 November; seven-day acceptance awaits that window. Deploy/crash survival, viewer measurements and hand-off checks are recorded in STEALTH.md. |
| 6 | MCP endpoint and the existing Python client; site defaults in the host routing table; tagged caller outcomes and sequential caller migration | Interface and client deployed 5 November 2026; 21 verified first-run windows and 2 pending callers are recorded in `mosaic/CALLERS.md`. Fetch deadlines and cancellation passed production checks on `a1da357`. Browserbase remains until each caller has under 10% failures/fallbacks over its week. |
| 7 | Session log, failure video, canary; soak and fault tests | Every soak and fault mark in `REVIEW.md` §6 |

Phase 1 is the largest change and the one everything else depends on. Phases 3 to 5 can run in parallel after phase 2.

## Decisions for the owner

1. **Concurrency.** How many sessions at once? This sets `MAX_SESSIONS` and the Railway memory limit. A quiet session uses roughly 0.5 to 1.5 GB **[inference]**.
2. **Vault backend.** An encrypted file on the volume (recommended, no dependency) or an external manager such as 1Password or Bitwarden Secrets Manager?
3. **Ancestry's exit.** Which US state should the identity live in? A static residential or ISP address would hold steadier than a hardsession, at a higher price.
4. **Agent budgets.** A default daily byte budget per agent key, 1 GB (1,000,000,000 bytes), as selected by the owner. The phase 4 run has a separate 1 GB ceiling.
5. **Name and repository.** Keep `lostprojects/steel-browser`, or rename it now that it is our product?
6. **Upstream.** Should the session-pool and profile fixes go back to Steel as pull requests? Upstream issues #347 and #350 ask for them.
