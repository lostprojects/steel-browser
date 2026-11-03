# Mosaic fork of Steel Browser

This fork runs a self-hosted Steel browser on Railway for Mosaic's collector. It replaces Browserbase for pages that need a real browser, at a fraction of the cost: Railway compute plus Evomi residential traffic at about $1/GB, against Browserbase's $10–12/GB for proxy traffic.

The fork exists for three reasons. Upstream Steel cannot accept CDP connections through a public domain, it has no access control, and its default browser is easy for anti-bot systems to spot. Each change below fixes one of these and is kept small, so merging upstream stays easy.

Upstream: [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser). Upstream's own guides are in [docs/](docs/); this file covers only what differs.

## Changes from upstream

| Commit | Files | Change | Why |
|---|---|---|---|
| `346efeb` | `api/src/services/cdp/cdp.service.ts` | `changeOrigin: true` on the CDP WebSocket proxy | Chrome rejects a DevTools `Host` header that is not `localhost` or an IP, so every CDP client failed with a 500 behind Railway's domain. Same fix as upstream [PR #297](https://github.com/steel-dev/steel-browser/pull/297), which is still unmerged |
| `346efeb` | `api/src/utils/api-key.ts`, `api/src/index.ts`, `api/src/plugins/browser-socket/browser-socket.ts`, `api/src/env.ts` | Optional `STEEL_API_KEY` | Upstream has no authentication. Without a key, anyone who finds the URL can drive the browser and spend the proxy allowance |
| `47b549b` | `api/entrypoint.sh` | Start Xvfb before the API | The image installs Xvfb and sets `DISPLAY=:10` but never starts it, so headful Chrome failed with "Missing X server or $DISPLAY" |
| `64a0d74` | `api/src/services/timezone-fetcher.service.ts` | Ask ipinfo.io, ip-api.com and ipwho.is at once with a 6 s timeout | Upstream asks ipinfo.io alone with a 2 s timeout. Through a residential proxy that often fails, and the browser falls back to UTC, which contradicts a US exit IP. `TIMEZONE_SERVICE_URL` still selects a single service |
| — | `mosaic/stealth_check.py`, `FORK.md` | Measuring tool and this document | See [Measuring detection](#measuring-detection) |

When upstream merges PR #297, drop our copy of that line during the merge.

## Deployment

| Item | Value |
|---|---|
| Railway project / service | `vigilant-peace` / `Steel Browser` |
| Source | `lostprojects/steel-browser`, branch `main`. A push to `main` builds and deploys |
| Build | Root `Dockerfile` (Railway detects it) |
| URL | `https://steel-browser-production-e8d5.up.railway.app` |
| Health check | `/v1/health`, the only path that needs no key |

Railway variables:

| Variable | Value | Purpose |
|---|---|---|
| `DOMAIN` | `${{RAILWAY_PUBLIC_DOMAIN}}` | Makes session URLs use the public domain |
| `USE_SSL` | `true` | Session URLs use `https` and `wss` |
| `CDP_REDIRECT_PORT` | set by the template | Internal DevTools port |
| `STEEL_API_KEY` | secret | Turns on the key check |
| `CHROME_HEADLESS` | `false` | Headful Chrome on Xvfb. Headless mode exposes `HeadlessChrome` in the user agent, an 800×600 screen and no plugins |
| `SKIP_FINGERPRINT_INJECTION` | `true` | Turns off upstream's fingerprint spoofing. See [Detection findings](#detection-findings) |

`XVFB_SCREEN` (default `1920x1080x24`) sets the virtual screen. Pages read it from `window.screen`, so keep it a common desktop size.

The instance runs one browser at a time. A new session replaces the current one, so clients must run sequentially.

## Credentials

Values live in two files and nowhere else. Both hold the same names:

- `/Users/moi/nosync.nosync/-env/global.env` for any project on this machine
- `/Users/moi/nosync.nosync/Mosaic/.env`, because Mosaic scripts read only their project file

| Name | What |
|---|---|
| `STEEL_URL` | The service URL |
| `STEEL_API_KEY` | Must match the Railway variable. Change both files when rotating it |
| `EVOMI_RESIDENTIAL_PROXY_URL` | Evomi Core Residential, `http://user:pass@core-residential.evomi.com:1000` |
| `EVOMI_PREMIUM_PROXY_URL` | Evomi Premium Residential. Use it only for a site Core cannot pass |

## Using the service

Send the key on every request. HTTP clients use the `steel-api-key` header. CDP clients add `?apiKey=` to the session's `websocketUrl`. To open the dashboard in a browser, visit `/ui/?apiKey=…` once; the server then sets an HttpOnly cookie for that browser.

Create a session with the proxy, connect, work, then release it:

```python
body = {"blockAds": True, "proxyUrl": proxy_with_session}   # see below
session = POST /v1/sessions, body                           # with steel-api-key header
browser = playwright.chromium.connect_over_cdp(session["websocketUrl"] + "?apiKey=" + key)
...
POST /v1/sessions/{id}/release
```

Evomi reads targeting from the proxy password. Append parameters with underscores, for example `PASSWORD_country-US_session-ab12cd34_lifetime-30`. A `session` keeps one IP for `lifetime` minutes (default 30, maximum 1440), which a login or a cleared challenge needs. Use a new session ID for each independent job. `mosaic/stealth_check.py` has a `sticky()` helper that does this.

Steel looks up the proxy's exit IP and sets the browser's timezone to match, so leave `timezone` unset. If every lookup service fails, the server logs `[TimezoneFetcher] Using fallback timezone` and the browser runs on UTC; treat such a session as compromised and start another.

## Detection findings

Measured on 2 November 2026 with `mosaic/stealth_check.py probe`, through Evomi Core.

Anti-bot systems look for contradictions more than for any single unusual value. A US home IP with a UTC clock, or a window larger than its screen, gives a browser away even when each value looks normal alone. The fork's approach is to make the browser report itself truthfully and consistently, and to spoof only what cannot be made true.

| Signal | Upstream default | Spoofing off, headless | Headful on Xvfb, spoofing off (current) |
|---|---|---|---|
| User agent | Chrome 142–144, while the binary is 156 | `HeadlessChrome/156` | `Chrome/156` |
| Client hints in JavaScript | Empty, while HTTP headers send them | Consistent | Consistent |
| Screen / window | 800×600 screen with a 1920×1080 window | Same | 1920×1080 / 1919×1079 |
| WebGL renderer | Changes every session; vendor reads `0` | SwiftShader | None (WebGL unavailable) |
| Cores / memory | 8–12 / 8 GB | 32 / 32 GB | 48 / 32 GB (the host's real values) |
| Plugins | 0 | 0 | 0 |
| Timezone against exit IP | Matches when the lookup succeeds, otherwise UTC | Same | Same, until the timezone fix above |
| deviceandbrowserinfo.com flags | CDP, timing, worker values | CDP (page and worker), bot user agent | CDP (page and worker) |

Upstream's spoofing caused most of the contradictions, and headless mode caused the rest. Both are now off.

What remains:

1. **CDP detection.** Puppeteer inside Steel, and the Playwright client, both send `Runtime.enable`, which pages can detect. Steel's recorder also adds a global function, `__steelBrowserInteractionLog`, to every page.
2. **No WebGL.** Real desktops have WebGL. Railway has no GPU, so the browser needs at least software WebGL that reports a believable renderer.
3. **No plugins, and 48 cores.** Both are true of the host and rare on a desktop.

## Route results

Mosaic collector routes, run with `mosaic/stealth_check.py routes core`. A route passes when the page's real content loads with no challenge.

| Route | Upstream default, Core | Upstream default, Premium | Headful, spoofing off, Core |
|---|---|---|---|
| Anna's Archive search | Fail: DDoS-Guard "I'm not a robot" checkbox | Fail: same | Fail: same (541 KB) |
| Bizapedia people page | Fail: drag-and-drop "Human Verification" | Fail: same | Pass, 16 s, 998 KB |
| Utah Digital Newspapers search | Pass | not run | Pass, 5 s, 145 KB |
| Ancestry sign-in | Fail: Cloudflare "Browser Validation Error 54" | Fail: same | Pass, 4 s, 395 KB |
| Newspapers.com sign-in | Pass | not run | Pass, 5 s, 809 KB |
| Fold3 login | Pass | not run | Pass, 5 s, 737 KB |

Premium Residential changed nothing on the failing routes, so the IP was never the cause. Removing the spoofing and running headful turned two failures into passes. Use Core.

Bytes are what Chrome received for the page, as reported by CDP `Network.loadingFinished`. At Core's $0.99/GB, a megabyte costs about a tenth of a cent.

## Next steps

1. Quiet CDP: alias `puppeteer-core` to `rebrowser-puppeteer-core`, make the recorder binding optional, and use Patchright on the client side.
2. Restore WebGL with software rendering and check what renderer string it reports.
3. Rerun the probe and routes after each change, and update the tables above.
4. If a site still blocks after that, try Camoufox, which spoofs at engine level, rather than adding JavaScript patches to Chromium.

## Measuring detection

`mosaic/stealth_check.py` needs Playwright (`pip install playwright`) and reads its settings from the environment or `global.env`.

```bash
python mosaic/stealth_check.py probe                          # fingerprint signals and bot-test flags
python mosaic/stealth_check.py probe '{"headless": true}'     # same, with per-session options
python mosaic/stealth_check.py routes core                    # all routes through Evomi Core
python mosaic/stealth_check.py routes premium annas ancestry  # chosen routes through Premium
```

Failed routes save a screenshot and the page text to `./stealth-failures/`. Run it from a temporary directory and delete that folder afterwards.

## Merging upstream

```bash
git fetch upstream
git merge upstream/main
```

Conflicts can arise only in the files listed under [Changes from upstream](#changes-from-upstream). After merging, typecheck with `cd api && npx tsc --noEmit`, push, and rerun the probe once the deploy finishes.
