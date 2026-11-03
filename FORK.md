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
| `64a0d74` | `api/src/services/timezone-fetcher.service.ts` | Ask ipinfo.io, ip-api.com and ipwho.is at once with a 6 s timeout | Upstream asks ipinfo.io alone with a 2 s timeout, and a failure leaves the browser on UTC. This did not make the lookup reliable on Railway (see [Using the service](#using-the-service)), so clients pass `timezone` themselves. `TIMEZONE_SERVICE_URL` still selects a single service |
| `8d4af8a` | `api/package.json`, `package-lock.json` | Alias `puppeteer-core` to `rebrowser-puppeteer-core@23.6.101` | Puppeteer sends `Runtime.enable` to every page and worker. The rebrowser build is the same 23.6.0 release without that call. Imports are unchanged |
| `9933006` | `api/src/env.ts`, `api/src/services/cdp/instrumentation/target-manager.ts` | Optional `CAPTURE_CONSOLE_EVENTS` | Steel's own target manager enables `Runtime` and `Log` on every page and worker to log console output. Chrome then serializes console arguments, which pages detect. `false` skips those two domains; the default keeps upstream behaviour |
| `e94f346`, `097cb0d` | `mosaic/stealth_check.py`, `FORK.md` | Measuring tool and this document | See [Measuring detection](#measuring-detection) |

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
| `CAPTURE_CONSOLE_EVENTS` | `false` | Stops Steel listening to page and worker consoles, which pages detect. Page console output no longer reaches Steel's logs |

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
proxy = sticky(EVOMI_RESIDENTIAL_PROXY_URL)                 # one exit IP for the job
body = {"blockAds": True, "proxyUrl": proxy, "timezone": exit_timezone(proxy)}
session = POST /v1/sessions, body                           # with steel-api-key header
browser = patchright.chromium.connect_over_cdp(session["websocketUrl"] + "?apiKey=" + key)
...
POST /v1/sessions/{id}/release
```

`sticky()` and `exit_timezone()` are in `mosaic/stealth_check.py`.

Use Patchright as the client. Stock Playwright sends `Runtime.enable` and undoes the server-side fixes.

Evomi reads targeting from the proxy password, with parameters joined by underscores. `sticky()` appends `_country-US_hardsession-<id>`. A `hardsession` keeps one IP for as long as Evomi can, which a login or a cleared challenge needs. The softer `session-<id>_lifetime-<minutes>` may change IP. Use a new ID for each independent job. Requests from Railway and from a Mac with the same ID leave through the same IP.

Pass `timezone` yourself. Steel's own lookup, made from Railway through the proxy, returned Railway's location (Ashburn, America/New_York) in three of three sessions, while the browser left through residential IPs in Florida, California and Texas. The cause is not yet known. `exit_timezone()` asks ipwho.is through the same sticky proxy, and the browser's timezone then matched its exit IP in every session tested.

## Detection findings

Measured on 2 November 2026 with `mosaic/stealth_check.py probe`, through Evomi Core.

Anti-bot systems look for contradictions more than for any single unusual value. A US home IP with a UTC clock, or a window larger than its screen, gives a browser away even when each value looks normal alone. The fork's approach is to make the browser report itself truthfully and consistently, and to spoof only what cannot be made true.

| Signal | Upstream default | Spoofing off, headless | Headful, spoofing off | Plus quiet CDP (current) |
|---|---|---|---|---|
| User agent | Chrome 142–144, while the binary is 156 | `HeadlessChrome/156` | `Chrome/156` | Same |
| Client hints in JavaScript | Empty, while HTTP headers send them | Consistent | Consistent | Same |
| Screen / window | 800×600 screen with a 1920×1080 window | Same | 1920×1080 / 1919×1079 | Same |
| WebGL renderer | Changes every session; vendor reads `0` | SwiftShader | None (WebGL unavailable) | Same |
| Cores / memory | 8–12 / 8 GB | 32 / 32 GB | 48 / 32 GB (the host's real values) | Same |
| Plugins | 0 | 0 | 0 | Same |
| Timezone against exit IP | Matches when Steel's lookup works, otherwise wrong | Same | Same | Matches (client-supplied) |
| deviceandbrowserinfo.com flags | CDP, timing, worker values | CDP (page and worker), bot user agent | CDP (page and worker) | None |

Upstream's spoofing caused most of the contradictions, and headless mode caused the rest. Both are now off.

The CDP flag had three sources, found one at a time. Switching the client to Patchright left the flag in place, and so did the rebrowser Puppeteer build, which the patch's own debug log (`REBROWSER_PATCHES_DEBUG=1`) confirmed was active. Steel's `/v1/scrape`, with no client connected, still raised it. The last source was Steel's target manager enabling `Runtime` and `Log` for console logging. The test puts a getter on an `Error`'s `stack` and calls `console.log` on it; any client listening to the console serializes the error and runs the getter. All three fixes are needed.

What remains:

1. **No WebGL.** Real desktops have WebGL. Railway has no GPU, and WebGL is unavailable even though Steel launches headful Chrome with `--use-gl=swiftshader`. Recent Chrome releases restrict the automatic SwiftShader fallback, which is the likely cause; this is not yet confirmed.
2. **No plugins, and 48 cores.** Both are true of the host and rare on a desktop.

## Route results

Mosaic collector routes, run with `mosaic/stealth_check.py routes core`. A route passes when the page's real content loads with no challenge.

| Route | Upstream default, Core | Upstream default, Premium | Headful, spoofing off, Core | Plus quiet CDP, Core (current) |
|---|---|---|---|---|
| Anna's Archive search | Fail: DDoS-Guard "I'm not a robot" checkbox | Fail: same | Fail: same (541 KB) | Fail: same (537 KB) |
| Bizapedia people page | Fail: drag-and-drop "Human Verification" | Fail: same | Pass, 16 s, 998 KB | Pass, 14 s, 997 KB |
| Utah Digital Newspapers search | Pass | not run | Pass, 5 s, 145 KB | Pass, 7 s, 284 KB |
| Ancestry sign-in | Fail: Cloudflare "Browser Validation Error 54" | Fail: same | Pass, 4 s, 395 KB | Pass, 6 s, 395 KB |
| Newspapers.com sign-in | Pass | not run | Pass, 5 s, 809 KB | Pass, 5 s, 1,096 KB |
| Fold3 login | Pass | not run | Pass, 5 s, 737 KB | Pass, 7 s, 734 KB |

Premium Residential changed nothing on the failing routes, so the IP was never the cause. Removing the spoofing and running headful turned two failures into passes. Use Core.

DDoS-Guard on Anna's Archive runs an automatic check for about 4 seconds, then shows its checkbox. The checkbox is drawn inside `#ddg-iframe` at about (+64, +36) from the iframe's top-left corner. A mouse click there, after a pause and a moved pointer, is accepted and opens a distorted-text CAPTCHA ("Type the text", with Refresh and Verify). Passing the automatic check would avoid both stages; the likeliest remaining causes are WebGL and plugins.

Bytes are what Chrome received for the page, as reported by CDP `Network.loadingFinished`. At Core's $0.99/GB, a megabyte costs about a tenth of a cent.

## Next steps

1. Restore WebGL with software rendering (`--enable-unsafe-swiftshader`, or Mesa llvmpipe through ANGLE) and check which renderer string the bot tests and DDoS-Guard accept.
2. Restore the PDF viewer plugins that headful Chrome reports on a desktop.
3. Rerun the probe and routes after each change, and update the tables above.
4. If DDoS-Guard still falls back to its manual check, solve the text CAPTCHA by reading a screenshot, or try Camoufox, which spoofs at engine level, rather than adding JavaScript patches to Chromium.

Steel's recorder binding, `__steelBrowserInteractionLog`, needs no change. It is registered in an isolated world, which page scripts cannot see. The recorder extension loads only in headless mode.

## Measuring detection

`mosaic/stealth_check.py` needs Patchright (`pip install patchright`) and reads its settings from the environment or `global.env`. `STEEL_CLIENT=playwright` switches to stock Playwright for comparison. Mosaic's `.venv` already has Patchright.

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
