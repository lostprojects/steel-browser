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

Phase 1 production checks ran three sessions concurrently with three distinct cookie values and three working CDP connections. A fourth request returned HTTP 429 after 5.46 seconds. A full commands snapshot completed. A second claim on `mosaic-acceptance` returned HTTP 409; its persistent cookie survived a full Railway redeploy. All checks used direct traffic, with zero residential bytes.

The final phase 1 release response confirmed `temporaryProfileRemoved: true` after a filesystem check. The following phase 2 measurements use Google Chrome 156.0.8078.79 and separate X displays.

Phase 2 candidates install Google Chrome 156.0.8078.79. The production checks opened three distinct X displays, refused all three unauthenticated viewer requests, and connected noVNC to a 1920×1080 display. Both health paths return the installed version without authentication; noVNC assets return 401 without a key.

Puppeteer's default popup and IPC protection overrides were removed. Rebrowser's popup test had exposed a closed-target error in Patchright 1.60.1. The corrected launch keeps those native protections enabled.

An initial 20-exit fingerprint batch completed 14 full checks with no detection flags. Six page reads failed before results could be collected; those samples are incomplete. The next batch uses a 60-second page-read timeout and preserves the original error before releasing the session. That batch completed 19 of 20 checks; one exit timed out before Device and Browser Info loaded. Chrome remained connected. The final batch allowed one recorded retry for explicit transport errors on the same exit. It returned 18 clear Device and Browser Info results, one missing result and one 60-second navigation timeout; no transport retry was triggered. Phase 2 stopped under the owner’s two-fix limit. Phase 3 was not started, and production was restored to accepted phase 1 commit `c73bfc3`.

The owner accepts Rebrowser's expected neutral results. Its current suite leaves isolated-world `sourceUrlLeak` and `mainWorldExecution` checks neutral when page hooks cannot observe them; `exposeFunctionLeak` remains neutral because no function is exposed. The service must have no positive detection result. Adding an artificial Patchright init script produced a document-interception flag, so acceptance uses the client's ordinary behavior without init scripts or exposed bindings.

### Phase 2 final measurements

All 20 final samples used Evomi Core and Google Chrome 156.0.8078.79. They used 20 distinct exit IPs. The table counts completed checks; a missing check does not pass.

| Check | Final result |
|---|---|
| Device and Browser Info | 18/20 clear; one result missing; one navigation timeout |
| Rebrowser | 19/20 completed with 17 green and three accepted neutral checks each; zero positive detections |
| Google Chrome full-version brand; webdriver false | 20/20 |
| Page hardwareConcurrency | 8 in 20/20 |
| Dedicated, shared and service worker hardwareConcurrency | 8 in all 19 completed worker checks |
| Timezone against ipwho.is | 20/20, after resolving the Indianapolis alias |
| WebGL | The same ANGLE/llvmpipe renderer in 20/20 |
| CreepJS | 19 completed: zero lies, 0% headless and 0% stealth; its weaker “like headless” score was 44% |
| BrowserLeaks WebRTC | 19 completed: no leak, no local or WebRTC public address; remote IP matched the recorded exit |
| TCP OS scoring | 19 completed; Android had the highest probabilistic score, 54–63%. These scores do not establish the exit’s actual OS |
| BrowserScan, advisory | One earlier candidate sample reported 100% authenticity and no bot detection |
| Pixelscan, advisory | Full fingerprint scan not completed; the first visit reached its homepage. The client now targets its fingerprint-check page |

Chrome returned `America/Indianapolis` for the exit geolocated as `America/Indiana/Indianapolis`. [IANA defines them as aliases](https://data.iana.org/time-zones/tzdb/backward), so this is a match.

Every row below used Chrome 156.0.8078.79. “Complete” means the detector result was collected without a positive detection; it does not erase the incomplete rows. TCP values are BrowserLeaks’ highest score, and the measurement client prints the full score distribution.

| Exit IP | Browser timezone | Device check | TCP top score |
|---|---|---|---|
| 98.206.164.224 | America/Chicago | Complete | Android (55%) |
| 172.59.91.130 | America/Chicago | Result missing | Android (58%) |
| 47.195.195.79 | America/New_York | Complete | Android (63%) |
| 208.59.107.46 | America/Chicago | Complete | Android (63%) |
| 73.146.157.102 | America/Indianapolis | Complete | Android (55%) |
| 47.159.33.175 | America/Los_Angeles | Navigation timeout | Not collected |
| 130.44.172.232 | America/New_York | Complete | Android (55%) |
| 67.184.143.154 | America/Chicago | Complete | Android (63%) |
| 67.163.35.18 | America/Chicago | Complete | Android (63%) |
| 184.14.108.112 | America/New_York | Complete | Android (63%) |
| 76.49.211.39 | America/New_York | Complete | Android (63%) |
| 76.87.0.19 | America/Los_Angeles | Complete | Android (55%) |
| 174.74.57.36 | America/Chicago | Complete | Android (54%) |
| 50.144.237.66 | America/New_York | Complete | Android (63%) |
| 23.187.120.199 | America/New_York | Complete | Android (63%) |
| 100.10.38.27 | America/New_York | Complete | Android (63%) |
| 35.150.242.19 | America/New_York | Complete | Android (58%) |
| 174.161.232.208 | America/Chicago | Complete | Android (63%) |
| 71.73.187.72 | America/New_York | Complete | Android (63%) |
| 172.118.80.80 | America/Los_Angeles | Complete | Android (55%) |

The whole phases 0–2 attempt used 137,169,680 residential bytes across 130 metered sessions, including timezone preflights and unsuccessful probes. All residential traffic used Evomi Core. Phase 0 and phase 1 acceptance used zero residential bytes. Quiet-mode and six-route acceptance were not run.

The unresolved check is consistent completion of the detector fixture. A continuation should inspect the missing response and wait for the actual result, then address navigation timeouts within the owner’s chosen retry limit. Phase 3 requires a new passing phase 2 acceptance set first.

After rollback, production reported Chromium 156.0.8078.73. Health and a fresh session’s creation/release passed. The release confirmed temporary-profile removal.

## Phase 2 continuation and acceptance

The owner authorized another attempt and then accepted replacing incomplete transport or fixture runs until 20 complete results had been collected on distinct exits. Positive detections still fail acceptance. All samples in this continuation used the same deployed phase 2 application and Google Chrome 156.0.8078.79.

The measurement client now waits for Device and Browser Info’s JSON verdict and Rebrowser’s complete set of checks. It records one retry on the same sticky exit for navigation timeouts or transient proxy failures. One detector navigation timeout recovered on that retry.

The accepted set contains 20 complete results on 20 distinct exits. Device and Browser Info returned no flags in all 20. Each Rebrowser result contained 17 green and the three accepted neutral checks. Page and worker hardware concurrency was eight throughout; Chrome brands and timezones matched in all 20. ANGLE/llvmpipe was stable, CreepJS reported zero lies and zero headless or stealth markers, and WebRTC exposed no address outside the recorded exit.

Three incomplete attempts were excluded from that set: a session-capacity refusal before a fingerprint session started, a proxy-tunnel failure before the detector loaded, and a Rebrowser result containing only 19 checks because its user-agent check had not finished. No collected result contained a positive detection. The earlier failed batches remain documented above.

BrowserScan reported 100% authenticity and no bot detection. Pixelscan completed its advisory scan and reported an inconsistent fingerprint and masking detected, with no automated behavior detected. Its verdict remains advisory under REVIEW.md.

| Accepted exit IP | Browser timezone | TCP top score |
|---|---|---|
| 38.42.72.54 | America/New_York | Android (63%) |
| 98.56.105.142 | America/New_York | Android (63%) |
| 99.128.61.48 | America/New_York | Android (62%) |
| 68.0.227.227 | America/New_York | Android (63%) |
| 75.117.253.16 | America/New_York | Android (63%) |
| 35.146.254.193 | America/Chicago | Android (58%) |
| 107.220.73.233 | America/Chicago | Android (63%) |
| 68.209.173.99 | America/New_York | Windows (53%) |
| 172.58.133.146 | America/New_York | Android (58%) |
| 96.231.135.152 | America/New_York | Android (63%) |
| 71.239.67.192 | America/Chicago | Android (63%) |
| 67.124.221.228 | America/Los_Angeles | Android (62%) |
| 172.59.147.206 | America/Los_Angeles | Android (58%) |
| 76.37.9.8 | America/New_York | Android (58%) |
| 192.230.144.192 | America/New_York | Android (55%) |
| 147.124.228.28 | America/New_York | Android (63%) |
| 99.182.38.73 | America/Chicago | Android (63%) |
| 173.89.151.52 | America/Chicago | Android (65%) |
| 172.56.61.146 | America/Chicago | Android (58%) |
| 184.164.116.150 | America/Denver | Android (63%) |

Phase 2 is accepted. The production build passed health and session creation/release checks, including temporary-profile removal. It is the rollback target for phase 3.

Checks already running when the twentieth complete exit was accepted brought this continuation to 24 complete results from 27 attempts, all 24 without a positive detection. The continuation used 61,782,678 residential bytes across 53 metered sessions. Cumulative phases 0–2 usage is 198,952,358 bytes, all Evomi Core.

## Phase 3 measurements and stopping point

Quiet mode is implemented but has not passed route acceptance. TypeScript passed, as did 18 focused tests across quiet transport/input, the session pool and commands routes. One further proxy test passed after the live-byte accounting correction described below.

Direct production checks used zero residential bytes. A quiet session started with no commands connection. Its full snapshot masked a password, and its commands ran in an isolated world. Native clicks reported `isTrusted: true` and display-relative screen coordinates. Typing preserved accented text, quotes and shell punctuation; an ffmpeg screenshot showed the expected 1920×1080 display. A native click also activated a button inside a cross-origin iframe. Releases confirmed temporary-profile removal.

Two input fixes were needed. `xdotool mousemove --sync` could wait until its timeout when the pointer was already at the destination, so native movement no longer uses that option. The helper now uses `C.UTF-8` because the image’s original locale rejected accented input. Both corrected behaviors passed the direct checks.

The residential detector checks enabled the commands reader before loading each detector, then ran a full accessibility snapshot and native click on the detector page. The command-method audit recorded `Accessibility.getFullAXTree`, with no `Runtime.enable`, CDP `Input`, `Network`, `Log` or `Fetch` calls from the service adapter. Patchright remained connected as the measurement client.

| Check | Quiet result |
|---|---|
| Device and Browser Info | 2/2 complete, no flags |
| Rebrowser | 2/2 complete, each with 17 green and three accepted neutral checks |
| Full snapshot and native click during both detector pages | Completed in both sessions |
| Google Chrome brand; webdriver false; exit timezone | Matched in both sessions |
| Page, dedicated, shared and service worker cores | Eight in the one full fingerprint probe |
| CreepJS | One full probe: zero lies, 0% headless and 0% stealth |
| WebRTC | One full probe: no leak; remote IP matched the exit |
| WebGL | The same ANGLE/llvmpipe renderer in both sessions |

Both sessions used Chrome 156.0.8078.79. The full probe used exit `97.220.240.104`, timezone `America/New_York`; BrowserLeaks’ highest TCP score was Android at 53%. The route pilot used `38.175.233.124`, timezone `America/Chicago`; its highest TCP score was Android at 54%. These probabilistic scores do not identify the exit’s actual OS.

The pilot completed one Anna’s Archive attempt. It failed after 84.68 seconds with zero search-result links and a DDoS-Guard checkbox visible in the captured display. Its new-exit retry was not run. Bizapedia was interrupted when the session was released to stop spending; no completed result was counted. The other four routes were not run. The required 20 runs per route, at least ten exits and baseline comparison remain unfulfilled.

The full quiet probe used 43,835,996 bytes, plus an 87,237-byte timezone preflight. The interrupted pilot used 32,222,503 bytes, plus an 85,693-byte preflight. The source of this higher traffic has not been isolated.

Live byte totals exposed a defect in the inherited proxy accounting: they included closed connections only. Open tunnels were added when the session ended, so the live budget monitor substantially understated spending. Route-level deltas from that build are consequently unreliable; the settled session totals above include the open tunnels. Commit `6bee0ba` corrects the getters to add active-tunnel statistics and tests that closing a tunnel does not count its bytes twice. This correction is part of the unaccepted candidate, not the phase 2 rollback image.

Phase 3 measurements used 76,231,429 residential bytes across four metered sessions. Cumulative usage across all phases and attempts is 275,183,787 bytes across 187 metered sessions, all Evomi Core. Residential checks stopped with 24,816,213 bytes remaining under the owner’s 300 MB ceiling; this cannot support the outstanding route acceptance set at the measured costs. A continuation needs authorization for more traffic and should diagnose the excess traffic before repeating the batch.

The bot tests did not detect the accessibility read, so the isolated-DOM fallback was not needed. Phase 3 remains unaccepted because its route checks are incomplete. Production was restored from accepted phase 2 deployment `6ffa7417-bc73-4f16-8090-59ed3c929e4a`. The restored image passed health, session creation and CDP checks; release confirmed temporary-profile removal and zero residential bytes. Quiet mode and the accounting correction remain committed for continuation. Browserbase remains available, and Mosaic’s scripts are unchanged.
