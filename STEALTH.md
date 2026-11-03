# Stealth

## The principle

Anti-bot systems look for contradictions more than for any single unusual value. A US home IP with a UTC clock, or a window larger than its screen, gives a browser away even when each value looks normal alone.

So the browser reports itself truthfully and consistently, as an ordinary Linux desktop. It spoofs nothing it can make true instead, and every fix removes a contradiction or an automation trace.

All measurements below were taken with [mosaic/stealth_check.py](mosaic/stealth_check.py) through Evomi Core Residential, on 2 and 3 November 2026.

## Signals

| Signal | Upstream default | Headful, spoofing off | Plus quiet CDP | Plus WebGL and plugins (earlier singleton) |
|---|---|---|---|---|
| User agent | Chrome 142–144, while the binary is 156 | `Chrome/156` | Same | Same |
| Client hints in JavaScript | Empty, while HTTP headers send them | Consistent | Same | Same |
| Screen / window | 800×600 screen with a 1920×1080 window | 1920×1080 / 1919×1079 | Same | Same |
| WebGL | Renderer changes every session; vendor reads `0` | Unavailable | Unavailable | `ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.6 256 bits), OpenGL 4.5)` |
| Plugins | 0 | 0 | 0 | 5 PDF viewer entries |
| Cores / memory | 8–12 / 8 GB | 48 / 32 GB (the host's real values) | Same | Same |
| Timezone against exit IP | Wrong when Steel's lookup fails | Same | Matches (client-supplied) | Matches |
| deviceandbrowserinfo.com flags | CDP, timing, worker values | CDP in page and worker | None | None |

Headless mode on its own, with spoofing off, showed `HeadlessChrome/156` in the user agent, 32 cores and SwiftShader WebGL.

## What each fix removed

1. **Spoofing off** (`SKIP_FINGERPRINT_INJECTION=true`). Upstream's fingerprint injection caused the contradictions: a fake Chrome version, a GPU that changed every session, an impossible screen, and web workers that disagreed with the page.
2. **Headful on Xvfb** (`CHROME_HEADLESS=false`, plus the Xvfb start in `entrypoint.sh`). Removed the headless user agent and screen.
3. **Quiet CDP.** The test puts a getter on an `Error`'s `stack` and calls `console.log` on it. Any CDP client listening to the console serializes the error and runs the getter. Three sources had to be closed, each found after the previous fix left the flag in place:
   - the client: Patchright in place of Playwright
   - Steel's Puppeteer: `rebrowser-puppeteer-core`, whose patch was confirmed active with `REBROWSER_PATCHES_DEBUG=1`
   - Steel's own console logging: `CAPTURE_CONSOLE_EVENTS=false`. Steel's `/v1/scrape`, with no client connected, still raised the flag until this one was fixed
4. **Timezone** passed by the client. See [USAGE.md](USAGE.md#pass-the-timezone-yourself).
5. **WebGL.** `chrome://gpu` showed WebGL disabled by Steel's `--disable-gpu`. Removing it, then `--in-process-gpu` (which made the GPU process crash and Chrome give up), and adding `--use-angle=gl --ignore-gpu-blocklist` gives software WebGL through Mesa llvmpipe. llvmpipe is what a Linux desktop without GPU drivers reports; SwiftShader, Chrome's own fallback, is a known headless signature.
6. **Plugins** (`ENABLE_PDF_VIEWER=true`).

Steel's recorder binding, `__steelBrowserInteractionLog`, needed no change. It lives in an isolated world, which page scripts cannot see. The recorder extension loads only in headless mode.

## Route results

The six Mosaic collector routes that used Browserbase's residential proxy. A route passes when the page's real content loads with no challenge. Bytes are what Chrome received for the page, from CDP `Network.loadingFinished`; at Core's $0.99/GB a megabyte costs about a tenth of a cent.

| Route | Upstream default | Upstream default, Premium proxy | Headful, spoofing off | Plus quiet CDP | Plus WebGL and plugins (earlier singleton) |
|---|---|---|---|---|---|
| Anna's Archive search | Fail: DDoS-Guard checkbox | Fail | Fail | Fail | Pass in 3 of 4 runs, 25–33 s, 117–713 KB |
| Bizapedia people page | Fail: drag-and-drop "Human Verification" | Fail | Pass, 16 s, 998 KB | Pass, 14 s, 997 KB | Pass, 40 s, 346 KB |
| Utah Digital Newspapers search | Pass | not run | Pass, 5 s, 145 KB | Pass, 7 s, 284 KB | Pass, 7 s, 306 KB |
| Ancestry sign-in | Fail: Cloudflare "Browser Validation Error 54" | Fail | Pass, 4 s, 395 KB | Pass, 6 s, 395 KB | Pass, 8 s, 390 KB |
| Newspapers.com sign-in | Pass | not run | Pass, 5 s, 809 KB | Pass, 5 s, 1,096 KB | Pass, 7 s, 836 KB |
| Fold3 login | Pass | not run | Pass, 5 s, 737 KB | Pass, 7 s, 734 KB | Pass, 6 s, 564 KB |

Premium Residential passed nothing that Core failed, so the IP was never the cause. Use Core.

## DDoS-Guard on Anna's Archive

DDoS-Guard runs an automatic check for about 4 seconds. When it fails, the page shows "Sorry, we could not verify your browser automatically" and an "I'm not a robot" checkbox.

The checkbox is drawn inside `#ddg-iframe` at about (+64, +36) from the iframe's top-left corner, which is narrower than the iframe itself. A mouse click there, after a pause and a moved pointer, is accepted. DDoS-Guard then shows a distorted-text CAPTCHA ("Type the text", with Refresh and Verify).

Since WebGL and the PDF plugins were added, the automatic check passes in 3 of 4 runs and the page loads its results without any checkbox. The failing run left through a different exit IP. Whether a retry on a new sticky session then passes has not been measured yet.

## Next steps

1. Give Mosaic a Steel backend in `scripts/browser/api.py` and move the collector routes to it, keeping Browserbase as a fallback.
2. Handle a DDoS-Guard fallback: retry once on a new sticky session, then click the checkbox and read the text CAPTCHA from a screenshot.
3. Watch the one remaining unusual value, 48 cores. CDP can override `navigator.hardwareConcurrency`, but an override that workers do not share would add a contradiction, so leave it unless a site is seen to care.
4. Keep the client timezone lookup through the sticky exit. The earlier measurements do not separate IP rotation from geolocation database differences.

## Measuring detection

`mosaic/stealth_check.py` needs Patchright (`pip install patchright`; Mosaic's `.venv` has it) and reads its settings from the environment or `global.env`. `STEEL_CLIENT=playwright` switches to stock Playwright for comparison.

```bash
python mosaic/stealth_check.py probe                          # fingerprint signals and bot-test flags
python mosaic/stealth_check.py probe '{"headless": true}'     # same, with per-session options
python mosaic/stealth_check.py routes core                    # all routes through Evomi Core
python mosaic/stealth_check.py routes premium annas ancestry  # chosen routes through Premium
```

Failed routes save a screenshot and the page text to `./stealth-failures/`. Run it from a temporary directory and delete that folder afterwards. The session pool allows at most three browsers. Keep the residential byte budget in view when running checks concurrently.

`chrome://gpu` explains why WebGL or GPU features are off. Its text is inside the `info-view` element's shadow root.

The measurement client sends `blockAds: false`, so ad blocking does not pause every request in Node. Browserbase remains available as a fallback.

## Phase checks

Phase 0 passed on 2 November 2026 (New York time). Railway marked the documentation-only commit `7515163` SKIPPED, with zero rebuilds; the measurement-client commit was also skipped. `main` and `deploy` matched after the pushes.

Phase 1 removes the shared profile, singleton and idle relaunch. TypeScript passes, and 68 tests across eight affected files passed before production acceptance. BrowserSession now contains the WebGL flags directly; no new anti-bot result is claimed here.
