# Stealth

Production has passed phases 0–3. See [the final phase 3 measurements](#phase-3-acceptance) for the accepted build and route results.

## The principle

Anti-bot systems look for contradictions more than for any single unusual value. A US home IP with a UTC clock, or a window larger than its screen, gives a browser away even when each value looks normal alone.

So the browser reports itself truthfully and consistently, as an ordinary Linux desktop. It spoofs nothing it can make true instead, and every fix removes a contradiction or an automation trace.

The measurements below were taken with [mosaic/stealth_check.py](mosaic/stealth_check.py) on 2 and 3 November 2026. Most use Evomi Core Residential; the early route table identifies the Premium comparison.

The early sections describe the former singleton browser. Phase 2 replaces its launch setup, and [phase 3 acceptance](#phase-3-acceptance) supplies the current route results and byte accounting.

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

Premium Residential passed nothing that Core failed in this early comparison. Core remains the default; these samples do not establish that exit IPs have no effect.

## DDoS-Guard on Anna's Archive

DDoS-Guard runs an automatic check for about 4 seconds. When it fails, the page shows "Sorry, we could not verify your browser automatically" and an "I'm not a robot" checkbox.

The checkbox is drawn inside `#ddg-iframe` at about (+64, +36) from the iframe's top-left corner, which is narrower than the iframe itself. A mouse click there, after a pause and a moved pointer, is accepted. DDoS-Guard then shows a distorted-text CAPTCHA ("Type the text", with Refresh and Verify).

In the early singleton measurements, WebGL and the PDF plugins brought the automatic check to 3 of 4 passes. The later phase 3 set achieved 19/20 initially and 20/20 with the allowed new-exit retry; see [the accepted results](#phase-3-acceptance).

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

## Phase 3 initial measurements and budget stop

At the initial stopping point, quiet mode was implemented but had not passed route acceptance. TypeScript passed, as did 18 focused tests across quiet transport/input, the session pool and commands routes. One further proxy test passed after the live-byte accounting correction described below.

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


## Phase 3 continuation

The owner authorized completing the task and raised the cumulative residential ceiling to 1,000,000,000 bytes. The continuation starts from the previously reported 275,183,787 bytes; every subsequent preflight, diagnostic and failed attempt remains in the cumulative total.

Hostname accounting identified the excess traffic. With only a blank page open, quiet Chrome used 13,111,862 bytes in 18 seconds, almost all from `optimizationguide-pa.googleapis.com`. Agent mode already disabled `OptimizationHints` through Puppeteer’s defaults. Applying that same setting to quiet mode reduced the equivalent blank-page measurement to 75,622 bytes, with no Optimization Guide request. A complete quiet fingerprint probe then used 1,950,267 bytes, compared with 43,835,996 before the correction.

The proxy now reports live and settled bytes by hostname as `proxyTraffic`, without URL paths or credentials. The production diagnostic’s hostname totals matched its settled aggregate exactly. The measurement client also locks its shared ledger and no longer enables its unused CDP Network listener.

An intermediate route batch completed 15 rounds. Anna’s Archive and all three login pages passed 15/15; Bizapedia passed 14/15 and Utah Digital Newspapers passed 13/15. Bizapedia’s failure showed a Cloudflare checkbox. The client now locates Turnstile through Chrome’s frame inventory, including frames inside closed shadow roots; a later round cleared that checkbox with native input and loaded the people page. The two Utah failures showed Chrome’s `ERR_TIMED_OUT` page on exits `47.145.191.130` and `47.230.57.176`. These failures remain in the intermediate results.

Four additional rounds were incomplete. A challenge redirect briefly removed the document body; a stalled Utah read exceeded the intended measurement window; a frame-owner read used an unsupported SDK argument; and a service command lost its isolated context during navigation. The client now bounds its reads and tolerates document replacement. The service tracks worlds and object handles by frame, preserving the main frame when an unrelated iframe navigates. Seven focused quiet-mode checks, including the new regression check, passed along with TypeScript.

The corrected application is commit `bfbc39f`. Its full fingerprint probe passed with full accessibility snapshots and native clicks active. The final route sets below followed this correction.

The client preserves first-attempt failures and records at most one new-exit retry separately for explicit connection/proxy errors; Anna’s Archive retains its one new-exit challenge retry. This is measurement-client behavior; no service proxy manager or routing ladder has been added.

The corrected build’s full quiet probe used exit `32.216.35.29` with `America/New_York`. Device and Browser Info returned no flags; Rebrowser returned 17 green checks and the three approved neutral checks. Full snapshots and native clicks completed on both detector pages.

The page and all three worker types reported eight cores, CreepJS reported zero lies and zero headless or stealth markers, and WebRTC reported no leak with the matching remote IP. The TCP classifier’s highest score was Android at 54%; this remains a probabilistic estimate.

The commands audit contained no `Runtime.enable`, CDP `Input`, `Network`, `Log` or `Fetch` calls.

The final route measurements use this separate full detector probe, then record a snapshot, native click and TCP score for each route session. Repeating the detector fixtures before each route group produced three incomplete fixture runs before any target route was attempted. The acceptance counts include every completed target outcome, including those collected before a later interruption; incomplete groups do not erase earlier failures.

A Bizapedia failure exposed a drag target labelled “Place here,” while the helper expected “Drop here.” The helper now accepts both labels and handles the drag before unrelated CAPTCHA frames.

A DDoS-Guard checkbox read also stalled while its frame document changed; the helper now uses the visible frame’s bounds. Frame-owner reads retry after document replacement. These changes are confined to the measurement client, and the earlier failed outcomes remain recorded.

External API and CDP connections then reset during two route groups, and an independent Railway CLI request returned `ECONNRESET`. The groups’ completed Anna’s Archive results remain in the count. A separate Anna retry failed before attaching to Chrome, so it produced no target result.

All those sessions’ bytes are included.

To finish without that unstable external connection, the same Patchright 1.60.1 measurement client ran temporarily beside the production API on Railway. It uses loopback API/CDP addresses and the same Chrome build, Core exits and quiet commands. No application deployment or launch setting changed.

Route durations therefore include two client locations; the final measurements distinguish their timings. The temporary client and SSH key are removed after collection.

## Phase 3 acceptance

Phase 3 is accepted on production application commit `bfbc39f`, deployment `89b38d9f-9008-45a5-86e3-4557db263f17`, with Google Chrome 156.0.8078.79. The full snapshot and native-click detector check passed on this build, and the final route sets meet REVIEW.md’s marks.

The six-route matrix completed 20 full groups on 20 distinct exits. Three interrupted groups also produced completed Anna’s Archive observations; the primary Anna count uses its first 20 completed observations, including the failed one from an interrupted group. None of those failures was discarded.

| Route | First attempt | After allowed Anna retry | Distinct exits in primary set | Route bytes, first attempts | Median seconds from Railway |
|---|---:|---:|---:|---:|---:|
| Anna’s Archive | 19/20 | 20/20 | 20 | 41,705,644 | 19.36 |
| Bizapedia | 19/20 | 19/20 | 20 | 59,868,506 | 17.72 |
| Utah Digital Newspapers | 20/20 | 20/20 | 20 | 3,446,943 | 1.15 |
| Ancestry sign-in | 20/20 | 20/20 | 20 | 23,168,780 | 1.67 |
| Newspapers.com sign-in | 20/20 | 20/20 | 20 | 31,542,419 | 1.04 |
| Fold3 login | 20/20 | 20/20 | 20 | 23,203,394 | 1.40 |

Route bytes are live forwarder deltas for the first target attempt. They exclude timezone and fingerprint preflights and the Anna retry; cumulative session totals below include all traffic. Timing medians use the Railway-local measurements because the earlier external client added substantial connection latency.

Anna’s failed primary attempt was exit `172.56.81.112`. Its one completed retry on `47.188.51.52` passed in 18.61 seconds, with 2,290,132 route bytes.

Three additional Anna observations were collected while finishing the other routes: two passed initially, and the third failed initially and passed its one new-exit retry. Across all 23 completed Anna observations, 21 passed initially and all 23 passed with their allowed retry.

Bizapedia’s one primary failure was the previously documented drag challenge on `96.241.153.166`. Later native-checkbox attempts passed; the failure remains in its 19/20 result.

Utah’s original matrix result was 18/20. Exits `47.201.105.27` and `47.18.183.102` showed Chrome’s connection-error page; the helper then aborted the intended same-exit retry because `Page.stopLoading` had no active document. The helper now preserves the original transport error and permits the next navigation in that case.

A separately declared 20-exit Utah rerun after that correction passed 20/20. None needed a navigation retry or a new exit. The earlier failed exits were not retested, so the rerun does not establish that those exits recovered.

Every final route result, including Anna’s allowed retry, is at least 19/20. That is within one run of the maximum possible 20/20 baseline, satisfying the comparison bound without assuming a measured Browserbase score. No new Browserbase baseline was run; comparative latency and bandwidth remain unmeasured.

The table below records every exit that produced a completed route in the final matrix. All used Chrome 156.0.8078.79, eight page cores and the same ANGLE/llvmpipe renderer. Louisville is the IANA alias of Kentucky/Louisville; the recorded browser and exit timezones agree after resolving aliases.

| Sample | Exit IP | Browser timezone | TCP highest score | Completed outcomes |
|---|---|---|---|---|
| 4 | 69.230.80.63 | America/Chicago | Android (63%) | All six passed |
| 5 | 24.153.113.199 | America/New_York | Android (63%) | All six passed |
| 6 | 73.220.246.16 | America/Los_Angeles | Android (63%) | annas pass |
| 7 | 96.241.153.166 | America/New_York | Android (63%) | annas pass; bizapedia fail; udn pass; ancestry pass; newspapers pass; fold3 pass |
| 8 | 172.56.81.112 | America/Phoenix | Android (58%) | annas fail |
| 9 | 74.131.82.88 | America/Louisville | Android (63%) | All six passed |
| 10 | 71.76.183.114 | America/New_York | Android (63%) | annas pass |
| 11 | 76.186.135.169 | America/Chicago | Android (63%) | All six passed |
| 12 | 50.47.213.90 | America/Los_Angeles | Android (63%) | All six passed |
| 13 | 143.105.159.213 | America/Phoenix | Android (63%) | All six passed |
| 14 | 57.138.131.177 | America/Chicago | Android (63%) | All six passed |
| 15 | 66.44.71.105 | America/New_York | Android (63%) | All six passed |
| 16 | 47.201.105.27 | America/New_York | Android (63%) | annas pass; bizapedia pass; udn fail; ancestry pass; newspapers pass; fold3 pass |
| 18 | 76.210.66.34 | America/Chicago | Android (63%) | All six passed |
| 19 | 47.18.183.102 | America/New_York | Android (63%) | annas pass; bizapedia pass; udn fail; ancestry pass; newspapers pass; fold3 pass |
| 20 | 24.127.150.6 | America/Detroit | Android (63%) | All six passed |
| 21 | 68.230.230.224 | America/Chicago | Android (63%) | All six passed |
| 22 | 68.131.59.157 | America/New_York | Android (55%) | All six passed |
| 23 | 23.115.116.35 | America/Chicago | Android (63%) | All six passed |
| 24 | 173.81.216.158 | America/Chicago | Android (65%) | All six passed |
| 25 | 100.16.114.124 | America/New_York | Android (63%) | All six passed |
| 26 | 69.162.242.230 | America/Denver | Android (55%) | All six passed |
| 27 | 76.33.206.3 | America/Los_Angeles | Android (49%) | annas fail; bizapedia pass; udn pass; ancestry pass; newspapers pass; fold3 pass |

The focused Utah set below passed all 20 initial target attempts. Each used the same Chrome version, full snapshot and native click; all recorded eight cores and the same renderer.

| Exit IP | Browser timezone | TCP highest score |
|---|---|---|
| 69.174.136.65 | America/Chicago | Android (63%) |
| 24.228.83.66 | America/New_York | Android (63%) |
| 76.195.44.84 | America/New_York | Android (63%) |
| 173.175.36.210 | America/Chicago | Android (55%) |
| 100.11.156.83 | America/New_York | Android (63%) |
| 172.56.36.154 | America/Chicago | Android (58%) |
| 108.30.148.212 | America/New_York | Android (63%) |
| 68.105.201.252 | America/New_York | Android (63%) |
| 64.67.12.68 | America/New_York | Android (66%) |
| 35.145.125.112 | America/New_York | Android (49%) |
| 104.159.191.3 | America/Chicago | Android (63%) |
| 68.8.100.44 | America/Los_Angeles | Android (63%) |
| 98.16.119.202 | America/New_York | Android (63%) |
| 71.228.40.79 | America/Chicago | Android (63%) |
| 108.210.87.72 | America/Chicago | Android (63%) |
| 173.218.212.115 | America/New_York | Android (63%) |
| 76.32.187.187 | America/Los_Angeles | Android (49%) |
| 73.152.50.7 | America/New_York | Android (63%) |
| 174.176.227.75 | America/New_York | Android (63%) |
| 98.242.88.143 | America/New_York | Android (63%) |

Anna retry for sample 8: `47.188.51.52`, `America/Chicago`, Android (54%); Google Chrome 156.0.8078.79, passed.

Anna retry for sample 27: `209.252.174.20`, `America/Chicago`, Android (63%); Google Chrome 156.0.8078.79, passed.

The final direct smoke check passed health, quiet-session creation and release. Its full snapshot masked the password; the native click reported `isTrusted: true`. The command-method audit contained no forbidden instrumentation, and release confirmed temporary-profile removal and zero residential bytes.

Cumulative residential usage is 760,504,808 bytes (760.505 MB) across 334 metered sessions, all Evomi Core. This continuation used 485,321,021 bytes; the total includes earlier attempts, incomplete fixtures, diagnostics and timezone preflights for new-exit retries. It is 239,495,192 bytes below the owner’s revised 1 GB ceiling.

The production application remains healthy on the accepted phase 3 deployment. Browserbase remains available, and Mosaic’s scripts are unchanged. The temporary Railway measurement files and SSH key are removed after collecting these results.

## Phase 4 implementation checks

Measurements ran on 3–4 November 2026.

Phase 4 is implemented, but full acceptance remains unmet. Bizapedia missed its
pass and bandwidth marks, login preservation remains unconfirmed, and the direct
route checks used one Railway egress rather than twenty distinct exits.

The owner set both the daily per-agent budget and this run's ceiling to
1,000,000,000 residential bytes. Phase 3's accepted route table remains the
comparison baseline; it was not re-measured. All residential checks used Evomi Core.

Mosaic's pool client is active. Three simultaneous direct callers retained distinct
sessions and page titles; a fourth received the queued 429 and opened the temporary
Browserbase fallback. This used zero residential bytes.

Browserbase remains only
until phase 6 moves the callers.

The identity-policy check passed both waiting and throwaway modes, including
acquisition after release, using 77,831 bytes. The activated client read the named
`mosaic` budget as 1,000,000,000 bytes and reconnected to its original page with the
form value intact.

Killing a separate client also preserved its session, CDP target
and form value. Both reattachment checks used zero residential bytes.

The source identity contained 101 cookies, of which 87 were unexpired. The first
import verified all 87, but reopening after site visits had lost 18 session cookies;
24 source cookie pairs were absent, with six others potentially changed by the sites.

Chrome now saves session cookies on release. A fresh import and reopen preserved
87/87.

The second migration correction materialized all 48 local-storage entries
across two origins.

All three sites still displayed sign-in links after both fixes,
so login preservation remains unconfirmed. The local credential file is retained,
unused by the new client, and must remain until a manual login check passes.

The initial import used 39,129 bytes. The three homepage login checks used
6,953,649, 5,262,616 and 3,986,192 residential bytes respectively.

The first cookie comparison used 33,910 bytes. The corrected import used 44,826
bytes and its reopen used 40,229 bytes; the storage import used 54,903 bytes.

The 100,000-byte temporary session budget ended the browser with
`residential_budget_exceeded` at 148,475 bytes. The one-second sampler permits
overshoot. A direct download returned HTTP 200, 68 bytes and the test cookie,
with zero residential traffic.

The visual-puzzle fixture returned `challenge_required`, a valid 28,225-byte PNG
and a noVNC link, retained its session, and allowed a second caller to load its
page. Native checkbox and drag fixtures both cleared, recorded their action and
reported trusted browser events.

A live Bizapedia checkbox also cleared and returned 51 payload links in 7.988 server seconds, using 3,141,128 residential bytes. The synthetic checks used zero residential bytes.

The first handoff fixture failed because it nested synchronous Patchright runtimes;
the next encountered a full pool. Both failures preceded the successful check.

The first deployment failed startup because its generated schema used a boolean
OpenAPI `exclusiveMinimum`. It was rolled back to accepted phase 3 before any
residential session ran. Health and direct creation/release passed after rollback.

An inclusive one-byte minimum fixed the schema; its Fastify compilation regression
passed with all ten pool tests.

The HTTP reader initially raised TypeError from a non-context-manager response.
`Session.stream` fixed it; the local direct example.com request returned HTTP 200
and 579 response bytes (772 base64 characters).

The first managed exit failed before Chrome (412 bytes).
An eight-character sticky ID passed (19,015 bytes); a sixteen-character comparison
failed (412 bytes).

Ancestry's initial pilot encountered the same allocation error
(412 bytes). The allocator now uses eight hexadecimal characters. Settled usage after these
initial checks was 20,251 residential bytes.

The initial focused set passed 18 tests with two skipped; six new module checks
also passed. TypeScript passed after the final service correction.

Earlier focused validation
passed 39 tests; the cookie/link correction passed 18 with two skipped.

The later routing/challenge file pair passed five tests, the routing/proxy pair passed four,
and the final five-test routing file covered release before escalation and retained
successes. The final accounting file passed three tests, including the daily reset
and cumulative per-key totals across midnight.

These sets overlap; each count describes its own validation run.

The final application build `c364bd5` passed Railway health and direct quiet-session
creation/release, using zero residential bytes. Its persisted route table retained
the measured rungs and all six splitting policies.

### Exit timezones

20/20 completed lookups matched on 20 distinct exits. Both service and browser used ipwho.is through the same exit.

The twenty-request batch had two additional session-start errors; two later completed checks supplied the remaining distinct exits. The earlier sixteen-character allocation failure is recorded separately above.

| Sample | Exit | Browser timezone | Exit timezone | Match | Settled bytes / error |
| --- | --- | --- | --- | --- | --- |
| 1 | — | — | — | — | HTTPError |
| 2 | 96.255.86.34 | America/New_York | America/New_York | True | 89,461 |
| 3 | 172.58.55.108 | America/Chicago | America/Chicago | True | 90,125 |
| 4 | 66.215.34.132 | America/Los_Angeles | America/Los_Angeles | True | 87,091 |
| 5 | — | — | — | — | HTTPError |
| 6 | 153.66.245.128 | America/New_York | America/New_York | True | 102,233 |
| 7 | 72.220.218.227 | America/Los_Angeles | America/Los_Angeles | True | 89,729 |
| 8 | 99.36.4.251 | America/Chicago | America/Chicago | True | 91,604 |
| 9 | 104.33.151.4 | America/Los_Angeles | America/Los_Angeles | True | 91,932 |
| 10 | 107.210.146.102 | America/Chicago | America/Chicago | True | 85,891 |
| 11 | 24.239.46.231 | America/New_York | America/New_York | True | 87,106 |
| 12 | 24.248.240.182 | America/Chicago | America/Chicago | True | 83,020 |
| 13 | 108.206.92.87 | America/Los_Angeles | America/Los_Angeles | True | 89,181 |
| 14 | — | — | — | — | HTTPError |
| 15 | 65.110.113.159 | America/New_York | America/New_York | True | 82,813 |
| 16 | 67.80.248.254 | America/New_York | America/New_York | True | 95,377 |
| 17 | 104.0.108.245 | America/New_York | America/New_York | True | 89,771 |
| 18 | 47.225.111.83 | America/Detroit | America/Detroit | True | 78,371 |
| 19 | 70.177.134.162 | America/New_York | America/New_York | True | 108,015 |
| 20 | 172.59.191.203 | America/Chicago | America/Chicago | True | 94,674 |
| 21 | 72.179.153.45 | America/Chicago | America/Chicago | True | 89,459 |
| 22 | 24.144.219.200 | America/New_York | America/New_York | True | 101,152 |
| 23 | 108.238.54.95 | America/Chicago | America/Chicago | True | 85,334 |

### Splitting and detector checks

The first policy was tested before enabling the six sites. Host accounting later showed 228,933 bytes for Google Tag Manager in one Ancestry session.

Splitting was disabled while adding that refused host, then re-enabled only after the second detector pass. Unknown hosts and challenge providers stay residential.

| Policy | Exit | Device flags | Rebrowser green / neutral / positive | CreepJS lies / headless / stealth | Bytes |
| --- | --- | --- | --- | --- | --- |
| 1 | 71.12.194.114 | 0 | 17 / 3 / 0 | 0 / 0 / 0 | 1,765,246 |
| 2 | 70.170.128.47 | 0 | 17 / 3 / 0 | 0 / 0 / 0 | 1,776,573 |

Policy 1: browser/exit timezone `America/Chicago` / `America/Chicago`; page and worker cores eight; device memory 32 GB; screen [1920, 1080]; window [1919, 1079]; plugins 5; media devices 0. Google Chrome 156.0.8078.79, `webdriver=false`, and ANGLE/llvmpipe agreed.

Full snapshots contained 8204 and 32779 characters; both native clicks passed.

CreepJS like-headless was 44 (advisory). WebRTC reported no leak; TCP scoring: Zardaxt OS Scoring	Android (63%), Linux (50%), macOS (34%), iOS (32%), Windows (22%).

Policy 2: browser/exit timezone `America/Los_Angeles` / `America/Los_Angeles`; page and worker cores eight; device memory 32 GB; screen [1920, 1080]; window [1919, 1079]; plugins 5; media devices 0. Google Chrome 156.0.8078.79, `webdriver=false`, and ANGLE/llvmpipe agreed.

Full snapshots contained 8204 and 29825 characters; both native clicks passed.

CreepJS like-headless was 44 (advisory). WebRTC reported no leak; TCP scoring: Zardaxt OS Scoring	Android (58%), Linux (43%), macOS (37%), iOS (36%), Windows (13%).

### Routing measurements

Pilots were separate from the declared batches. Raw HTML validation initially missed relative Bizapedia links; it now resolves them as browser anchor properties do.

A later challenge can appear after an early clear observation, so the ladder rechecks until payload arrives. Failed direct probes release their slot before escalating, including puzzles.

The first direct reprobes exposed that release defect and returned capacity errors; their two sessions were released with zero residential bytes.

Two external measurement clients stalled on reused API connections. The response retry recovered some attempts, but both runners were eventually stopped.

The client now uses a fresh connection per request with the same idempotency key across transport retries. Subsequent batches wait for existing jobs; concurrent Mosaic collectors caused capacity refusals in an intervening batch, preserved below.

| Route | Settled rung | First attempt | After retry/escalation | Distinct residential exits | Residential bytes/page | Phase 3 bytes/page | % of baseline |
| --- | --- | --- | --- | --- | --- | --- | --- |
| annas | 2 | 20/20 | 20/20 | Railway direct | 0.00 | 2,085,282.20 | 0.0% |
| bizapedia | 3 | 11/13 | 11/13 | 12 | ≥2,653,034.00 | 2,993,425.30 | ≥88.6% |
| udn | 2 | 20/20 | 20/20 | Railway direct | 0.00 | 172,347.15 | 0.0% |
| ancestry | 3 | 20/20 | 20/20 | 20 | 430,480.45 | 1,158,439.00 | 37.2% |
| newspapers | 1 | 20/20 | 20/20 | Railway direct | 0.00 | 1,577,120.95 | 0.0% |
| fold3 | 3 | 20/20 | 20/20 | 20 | 510,177.75 | 1,160,169.70 | 44.0% |

Bytes per page sum first, non-retry residential route deltas and divide by every batch attempt, including failures. They exclude exit preflight; the final run total includes preflight and all failures.

The earlier Fold3 batch first failed on rung 2, then passed on rung 3; that batch had 19/20 initial-rung passes and averaged 600,561.45 residential bytes per page (51.8% of baseline). The declared twenty-exit batch after the tracking-policy change is reported above.

Anna, Utah and Newspapers used Railway direct egress and zero residential bytes. Those twenty-attempt checks used one Railway egress, so they do not establish the brief's literal twenty-distinct-exit condition for direct routes.

Anna's focused retry check used three initial residential exits. The third first attempt was DDoS-Guard on `172.56.34.95` (48.961 seconds, 901,688 bytes). Its automatic retry on `65.32.187.27` passed with 116 links (16.473 seconds, 2,094,887 bytes). The two earlier initial attempts passed.

These forced-rung-3 checks are separate from Anna's direct-route batch.

Focused Anna retry observations

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | pass | 24.161.222.165 | 1,926,781 | 0 | 116 | 19.729 | — |
| 2 | 3 | first | pass | 98.118.39.173 | 2,023,832 | 0 | 100 | 21.94 | — |
| 3 | 3 | first | fail | 172.56.34.95 | 901,688 | 0 | 0 | 48.961 | — |
| 3 | 3 | retry | pass | 65.32.187.27 | 2,094,887 | 0 | 116 | 16.473 | — |

annas final route batch

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 14.355 | 14.727 |
| 2 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 16.292 | 16.518 |
| 3 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 17.447 | 17.641 |
| 4 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 18.926 | 19.198 |
| 5 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 15.07 | 15.271 |
| 6 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 12.368 | 12.558 |
| 7 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 17.009 | 17.203 |
| 8 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 13.309 | 13.543 |
| 9 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 15.053 | 15.248 |
| 10 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 14.969 | 15.143 |
| 11 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 16.402 | 16.639 |
| 12 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 15.579 | 616.117 |
| 13 | 2 | first | pass | Railway / no exit result | 0 | 0 | 100 | 13.603 | 13.809 |
| 14 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 12.28 | 12.449 |
| 15 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 17.861 | 318.393 |
| 16 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 22.542 | 323.015 |
| 17 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 18.144 | 18.404 |
| 18 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 12.521 | 12.781 |
| 19 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 13.343 | 13.526 |
| 20 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 15.708 | 15.902 |

bizapedia final route batch

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | fail | 97.167.75.246 | 686,464 | 49,268 | 0 | 60.353 | 117.951 |
| 1 | 3 | retry | fail | 97.151.243.176 | 5,106,675 | 49,213 | 0 | 56.97 | 117.951 |
| 2 | 3 | first | pass | 204.232.106.9 | 2,412,945 | 0 | 51 | 8.201 | 8.756 |
| 3 | 3 | first | pass | 73.242.182.165 | 3,212,143 | 10,942 | 51 | 13.761 | 14.139 |
| 4 | 3 | first | pass | 208.102.93.47 | 4,430,046 | 0 | 51 | 8.922 | 9.362 |
| 5 | 3 | first | pass | 72.69.43.139 | 4,273,215 | 0 | 51 | 7.86 | 8.303 |
| 6 | 3 | first | pass | 174.65.71.100 | 2,123,385 | 0 | 51 | 10.346 | 10.732 |
| 7 | 3 | first | pass | 47.160.154.9 | 3,477,150 | 0 | 51 | 8.118 | 8.555 |
| 8 | 3 | first | pass | 99.108.73.27 | 2,454,266 | 0 | 51 | 13.735 | 14.074 |
| 9 | 3 | first | pass | 99.111.179.134 | 4,042,822 | 0 | 51 | 22.724 | 23.219 |
| 10 | 3 | first | pass | 47.195.24.185 | 3,208,912 | 0 | 51 | 7.989 | 8.64 |
| 11 | 3 | first | pass | 50.89.156.30 | 2,062,451 | 0 | 51 | 11.03 | 11.398 |
| 12 | — | — | ConnectionResetError | None | — | — | — | — | 645.023 |
| 13 | 3 | first | pass | 107.77.220.54 | 2,105,643 | 0 | 51 | 16.626 | 21.208 |

udn final route batch

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.917 | 1.151 |
| 2 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.942 | 1.106 |
| 3 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.894 | 1.049 |
| 4 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.917 | 1.087 |
| 5 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.87 | 1.031 |
| 6 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.882 | 1.046 |
| 7 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.874 | 1.042 |
| 8 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.873 | 1.04 |
| 9 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.885 | 1.096 |
| 10 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.876 | 1.038 |
| 11 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.854 | 1.01 |
| 12 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.86 | 1.021 |
| 13 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.892 | 1.201 |
| 14 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.855 | 1.016 |
| 15 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.858 | 1.043 |
| 16 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.885 | 1.038 |
| 17 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.881 | 1.051 |
| 18 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.874 | 1.056 |
| 19 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.848 | 1.008 |
| 20 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.875 | 1.052 |

ancestry final route batch

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | pass | 172.59.214.228 | 446,067 | 0 | 2 | 3.793 | 4.233 |
| 2 | 3 | first | pass | 71.112.216.139 | 478,451 | 0 | 2 | 2.729 | 3.068 |
| 3 | 3 | first | pass | 70.35.73.76 | 606,100 | 0 | 2 | 3.358 | 3.782 |
| 4 | 3 | first | pass | 140.141.148.150 | 354,500 | 0 | 2 | 2.929 | 3.346 |
| 5 | 3 | first | pass | 69.203.44.204 | 389,617 | 0 | 2 | 2.919 | 3.282 |
| 6 | 3 | first | pass | 98.193.116.50 | 573,571 | 0 | 2 | 3.42 | 3.767 |
| 7 | 3 | first | pass | 74.244.110.57 | 407,158 | 0 | 2 | 2.426 | 2.771 |
| 8 | 3 | first | pass | 99.72.117.156 | 398,161 | 0 | 2 | 4.233 | 4.574 |
| 9 | 3 | first | pass | 162.239.13.154 | 365,034 | 0 | 2 | 2.597 | 2.935 |
| 10 | 3 | first | pass | 173.49.241.155 | 353,568 | 0 | 2 | 3.802 | 4.319 |
| 11 | 3 | first | pass | 64.121.66.51 | 385,081 | 0 | 2 | 1.608 | 2.124 |
| 12 | 3 | first | pass | 108.84.241.174 | 484,967 | 0 | 2 | 1.714 | 2.034 |
| 13 | 3 | first | pass | 75.180.42.137 | 381,588 | 0 | 2 | 1.679 | 2.021 |
| 14 | 3 | first | pass | 24.140.201.101 | 572,783 | 0 | 2 | 1.803 | 2.255 |
| 15 | 3 | first | pass | 172.59.136.166 | 385,350 | 0 | 2 | 10.31 | 10.663 |
| 16 | 3 | first | pass | 153.66.248.7 | 459,951 | 0 | 2 | 2.265 | 2.632 |
| 17 | 3 | first | pass | 74.126.136.181 | 412,859 | 0 | 2 | 1.998 | 2.521 |
| 18 | 3 | first | pass | 99.66.76.147 | 295,170 | 0 | 2 | 9.226 | 9.58 |
| 19 | 3 | first | pass | 104.61.68.108 | 457,335 | 0 | 2 | 6.25 | 6.577 |
| 20 | 3 | first | pass | 108.81.232.106 | 402,298 | 0 | 2 | 2.223 | 2.544 |

newspapers final route batch

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | first | pass | Railway / no exit result | 0 | 613,283 | 2 | 0.367 | 0.713 |
| 2 | 1 | first | pass | Railway / no exit result | 0 | 613,284 | 2 | 0.415 | 0.604 |
| 3 | 1 | first | pass | Railway / no exit result | 0 | 613,282 | 2 | 0.342 | 0.429 |
| 4 | 1 | first | pass | Railway / no exit result | 0 | 613,284 | 2 | 0.5 | 0.602 |
| 5 | 1 | first | pass | Railway / no exit result | 0 | 613,282 | 2 | 0.353 | 0.475 |
| 6 | 1 | first | pass | Railway / no exit result | 0 | 613,284 | 2 | 0.334 | 0.407 |
| 7 | 1 | first | pass | Railway / no exit result | 0 | 613,282 | 2 | 0.329 | 0.409 |
| 8 | 1 | first | pass | Railway / no exit result | 0 | 613,285 | 2 | 0.36 | 0.426 |
| 9 | 1 | first | pass | Railway / no exit result | 0 | 613,282 | 2 | 0.354 | 0.415 |
| 10 | 1 | first | pass | Railway / no exit result | 0 | 613,283 | 2 | 0.276 | 0.362 |
| 11 | 1 | first | pass | Railway / no exit result | 0 | 613,282 | 2 | 0.358 | 0.423 |
| 12 | 1 | first | pass | Railway / no exit result | 0 | 613,283 | 2 | 0.379 | 0.451 |
| 13 | 1 | first | pass | Railway / no exit result | 0 | 613,285 | 2 | 0.261 | 0.333 |
| 14 | 1 | first | pass | Railway / no exit result | 0 | 613,282 | 2 | 0.338 | 0.4 |
| 15 | 1 | first | pass | Railway / no exit result | 0 | 613,284 | 2 | 0.314 | 0.376 |
| 16 | 1 | first | pass | Railway / no exit result | 0 | 613,283 | 2 | 0.479 | 0.552 |
| 17 | 1 | first | pass | Railway / no exit result | 0 | 613,282 | 2 | 0.319 | 0.435 |
| 18 | 1 | first | pass | Railway / no exit result | 0 | 613,285 | 2 | 0.326 | 0.461 |
| 19 | 1 | first | pass | Railway / no exit result | 0 | 613,283 | 2 | 0.724 | 0.815 |
| 20 | 1 | first | pass | Railway / no exit result | 0 | 613,283 | 2 | 0.271 | 0.337 |

fold3 final route batch

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | pass | 50.80.40.81 | 506,265 | 126,449 | 2 | 2.425 | 2.745 |
| 2 | 3 | first | pass | 73.99.85.206 | 511,144 | 170,032 | 2 | 2.014 | 2.413 |
| 3 | 3 | first | pass | 70.161.184.33 | 515,048 | 155,139 | 2 | 2.299 | 2.579 |
| 4 | 3 | first | pass | 76.153.109.14 | 519,941 | 163,708 | 2 | 2.568 | 2.851 |
| 5 | 3 | first | pass | 99.14.58.121 | 517,201 | 153,213 | 2 | 1.415 | 1.731 |
| 6 | 3 | first | pass | 50.24.234.127 | 504,757 | 152,500 | 2 | 1.862 | 2.333 |
| 7 | 3 | first | pass | 204.111.100.213 | 504,159 | 152,869 | 2 | 2.223 | 2.539 |
| 8 | 3 | first | pass | 172.7.149.149 | 515,381 | 154,086 | 2 | 1.054 | 1.341 |
| 9 | 3 | first | pass | 23.120.83.158 | 514,433 | 163,002 | 2 | 1.925 | 2.208 |
| 10 | 3 | first | pass | 174.22.205.85 | 509,717 | 158,412 | 2 | 2.013 | 2.337 |
| 11 | 3 | first | pass | 166.70.59.199 | 452,807 | 155,094 | 2 | 2.366 | 2.64 |
| 12 | 3 | first | pass | 45.22.69.180 | 514,645 | 160,022 | 2 | 1.205 | 1.501 |
| 13 | 3 | first | pass | 67.81.13.170 | 532,536 | 159,875 | 2 | 49.736 | 50.002 |
| 14 | 3 | first | pass | 136.53.63.22 | 503,996 | 155,160 | 2 | 1.045 | 1.364 |
| 15 | 3 | first | pass | 99.167.107.249 | 512,926 | 163,517 | 2 | 1.56 | 1.869 |
| 16 | 3 | first | pass | 72.182.161.169 | 503,672 | 147,377 | 2 | 5.085 | 293.577 |
| 17 | 3 | first | pass | 174.55.210.24 | 520,816 | 153,402 | 2 | 2.38 | 3.245 |
| 18 | 3 | first | pass | 98.149.231.142 | 522,285 | 164,047 | 2 | 2.808 | 3.369 |
| 19 | 3 | first | pass | 70.115.204.46 | 508,573 | 152,576 | 2 | 1.917 | 2.39 |
| 20 | 3 | first | pass | 24.46.49.50 | 513,253 | 153,293 | 2 | 1.328 | 1.886 |

### Earlier probes and incomplete batches

These observations remain separate from the declared final batches. Capacity errors and interrupted clients produced no confirmed route result; they are not converted into passes.

Initial probes before the final batches:

| Route | Rung 1 | Rung 2 | Rung 3 | Residential bytes |
| --- | --- | --- | --- | --- |
| Utah | Missing payload; 2,896 direct bytes | Passed; 50 links; 0.875 seconds | Unneeded | 0 |
| Newspapers | Passed; two fields; 613,283 direct bytes; 0.467 seconds | Unneeded | Unneeded | 0 |
| Ancestry | Access denied; 541,024 direct bytes | Challenge remained after 60.724 seconds | Allocation failed before navigation | 412 |

annas pilot

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | first | fail | Railway / no exit result | 0 | 902 | 0 | 2.837 | 15.855 |
| 1 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 12.634 | 15.855 |

udn pilot

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | first | fail | Railway / no exit result | 0 | 2,896 | 0 | 0.428 | 1.555 |
| 1 | 2 | first | pass | Railway / no exit result | 0 | 0 | 50 | 0.875 | 1.555 |

newspapers pilot

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | first | pass | Railway / no exit result | 0 | 613,283 | 2 | 0.467 | 0.725 |

fold3 pilot

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | first | fail | Railway / no exit result | 0 | 5,920 | 0 | 0.267 | 1.373 |
| 1 | 2 | first | pass | Railway / no exit result | 0 | 0 | 2 | 0.92 | 1.373 |

ancestry pilot

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | first | fail | Railway / no exit result | 0 | 541,024 | 0 | 0.281 | 61.156 |
| 1 | 2 | first | fail | Railway / no exit result | 0 | 0 | 0 | 60.724 | 61.156 |
| 1 | 3 | first | fail | Railway / no exit result | 0 | 0 | — | 0.009 | 61.156 |

bizapedia pilot

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | first | fail | Railway / no exit result | 0 | 157,024 | 0 | 0.511 | 206.863 |
| 1 | 2 | first | fail | Railway / no exit result | 0 | 0 | 0 | 61.794 | 206.863 |
| 1 | 3 | first | fail | 75.180.109.94 | 5,518,825 | 49,280 | 0 | 66.407 | 206.863 |
| 1 | 3 | retry | fail | 172.56.162.47 | 1,814,627 | 0 | 0 | 77.787 | 206.863 |

bizapedia validator

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | fail | 24.208.162.163 | 190,910 | 0 | 0 | 110.605 | 137.691 |
| 1 | 3 | retry | pass | 74.33.67.223 | 2,249,652 | 0 | 51 | 26.667 | 137.691 |

ancestry primary

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | pass | 98.118.31.242 | 727,448 | 0 | 2 | 3.133 | 3.438 |
| 2 | 3 | first | pass | 99.153.177.130 | 835,966 | 0 | 2 | 3.811 | 4.068 |
| 3 | 3 | first | pass | 172.59.88.228 | 649,488 | 0 | 2 | 22.183 | 22.468 |
| 4 | 3 | first | pass | 216.138.14.193 | 630,578 | 0 | 2 | 1.717 | 1.889 |
| 5 | 3 | first | pass | 73.57.190.158 | 621,798 | 0 | 2 | 2.757 | 2.923 |
| 6 | 3 | first | pass | 73.214.62.30 | 1,001,611 | 0 | 2 | 11.191 | 11.345 |
| 7 | 3 | first | pass | 104.50.56.209 | 661,129 | 0 | 2 | 2.091 | 2.249 |
| 8 | 3 | first | pass | 72.78.187.138 | 693,864 | 0 | 2 | 1.17 | 1.329 |
| 9 | 3 | first | pass | 172.59.15.195 | 398,506 | 0 | 2 | 11.959 | 12.11 |
| 10 | 3 | first | pass | 23.113.227.51 | 626,373 | 0 | 2 | 2.162 | 2.33 |
| 11 | 3 | first | pass | 76.34.10.128 | 613,663 | 0 | 2 | 2.503 | 2.657 |
| 12 | 3 | first | pass | 76.32.239.130 | 620,235 | 0 | 2 | 4.156 | 4.323 |
| 13 | 3 | first | pass | 153.66.157.151 | 589,519 | 0 | 2 | 3.586 | 3.734 |
| 14 | 3 | first | pass | 47.230.115.203 | 904,653 | 0 | 2 | 3.244 | 3.401 |
| 15 | 3 | first | pass | 172.6.143.162 | 859,006 | 0 | 2 | 3.724 | 304.124 |
| 16 | 3 | first | pass | 75.115.125.64 | 648,100 | 0 | 2 | 2.225 | 2.436 |
| 17 | 3 | first | pass | 24.73.61.252 | 620,829 | 0 | 2 | 1.93 | 2.089 |
| 18 | 3 | first | pass | 76.179.96.67 | 629,721 | 0 | 2 | 2.211 | 2.384 |
| 19 | — | — | client_interrupted_after_transport_stall | — | — | — | — | — | — |

bizapedia primary

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | pass | 173.76.84.157 | 2,039,874 | 0 | 51 | 6.003 | 6.257 |
| 2 | 3 | first | pass | 67.124.116.92 | 2,037,122 | 0 | 51 | 7.656 | 7.835 |
| 3 | 3 | first | fail | 70.189.6.174 | 680,422 | 49,213 | 0 | 62.7 | 374.48 |
| 3 | 3 | retry | pass | 97.208.220.117 | 2,641,551 | 0 | 51 | 11.274 | 374.48 |
| 4 | — | — | client_interrupted_after_transport_stall | — | — | — | — | — | — |

fold3 primary

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | first | fail | Railway / no exit result | 0 | 0 | 0 | 61.593 | 64.528 |
| 1 | 3 | first | pass | 76.87.120.1 | 526,069 | 126,796 | 2 | 2.588 | 64.528 |
| 2 | 3 | first | pass | 174.48.60.26 | 522,551 | 152,920 | 2 | 1.544 | 1.802 |
| 3 | 3 | first | pass | 67.80.233.128 | 563,817 | 159,147 | 2 | 9.669 | 9.962 |
| 4 | 3 | first | pass | 108.27.21.149 | 509,985 | 175,099 | 2 | 1.288 | 1.47 |
| 5 | 3 | first | pass | 172.11.36.154 | 1,073,885 | 153,981 | 2 | 3.413 | 3.578 |
| 6 | 3 | first | pass | 162.198.97.229 | 516,319 | 152,800 | 2 | 5.138 | 5.33 |
| 7 | 3 | first | pass | 73.127.54.248 | 1,047,342 | 155,254 | 2 | 3.753 | 3.915 |
| 8 | 3 | first | pass | 74.108.116.180 | 509,637 | 153,934 | 2 | 1.116 | 1.361 |
| 9 | 3 | first | pass | 35.145.239.191 | 1,059,179 | 154,662 | 2 | 3.582 | 3.741 |
| 10 | 3 | first | pass | 47.134.83.119 | 511,367 | 155,654 | 2 | 2.22 | 2.412 |
| 11 | 3 | first | pass | 73.156.192.25 | 512,897 | 159,340 | 2 | 1.479 | 1.631 |
| 12 | 3 | first | pass | 172.59.218.214 | 512,925 | 152,770 | 2 | 16.691 | 16.839 |
| 13 | 3 | first | pass | 107.212.253.58 | 521,734 | 152,881 | 2 | 2.799 | 2.953 |
| 14 | 3 | first | pass | 50.43.172.186 | 513,258 | 155,218 | 2 | 1.193 | 1.353 |
| 15 | 3 | first | pass | 73.235.153.175 | 526,488 | 155,223 | 2 | 2.239 | 2.399 |
| 16 | 3 | first | pass | 66.25.109.174 | 522,636 | 153,484 | 2 | 2.318 | 2.791 |
| 17 | 3 | first | pass | 107.200.139.187 | 497,834 | 152,857 | 2 | 1.248 | 1.397 |
| 18 | 3 | first | pass | 172.59.210.153 | 515,604 | 154,864 | 2 | 17.733 | 17.905 |
| 19 | 3 | first | pass | 75.253.85.96 | 522,291 | 152,657 | 2 | 2.599 | 2.771 |
| 20 | 3 | first | pass | 75.27.23.193 | 525,411 | 159,830 | 2 | 7.904 | 8.073 |

ancestry reprobe

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | — | — | HTTPError | — | — | — | — | — | 52.245 |

bizapedia reprobe

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | — | — | HTTPError | — | — | — | — | — | 51.715 |

ancestry final

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | — | — | HTTPError | — | — | — | — | — | 5.13 |
| 2 | 3 | first | pass | 68.186.232.111 | 407,418 | 0 | 2 | 5.146 | 5.634 |
| 3 | — | — | HTTPError | — | — | — | — | — | 5.309 |
| 4 | — | — | HTTPError | — | — | — | — | — | 5.125 |
| 5 | — | — | HTTPError | — | — | — | — | — | 5.161 |
| 6 | — | — | HTTPError | — | — | — | — | — | 5.131 |
| 7 | — | — | HTTPError | — | — | — | — | — | 5.119 |
| 8 | — | — | HTTPError | — | — | — | — | — | 5.124 |
| 9 | — | — | HTTPError | — | — | — | — | — | 5.123 |
| 10 | — | — | HTTPError | — | — | — | — | — | 5.482 |
| 11 | — | — | HTTPError | — | — | — | — | — | 5.127 |
| 12 | — | — | HTTPError | — | — | — | — | — | 5.139 |
| 13 | — | — | HTTPError | — | — | — | — | — | 5.117 |
| 14 | — | — | HTTPError | — | — | — | — | — | 5.166 |
| 15 | — | — | HTTPError | — | — | — | — | — | 5.104 |

bizapedia final

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | first | pass | 72.84.64.143 | 3,141,128 | 0 | 51 | 7.988 | 8.398 |

annas restore

| Sample | Rung | Attempt | Result | Exit | Residential bytes | Direct bytes | Payloads | Server seconds | Client seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | first | pass | Railway / no exit result | 0 | 0 | 116 | 13.016 | — |

### Final accounting

This task used 164,452,862 residential bytes (164.453 MB), leaving 835,547,138 bytes under its 1 GB ceiling. The service began with zero measured spend.

Its admin ledger across both UTC dates counts these checks, including failed launches, imports and retries. Concurrent collector work uses the separate named `mosaic` key and is excluded from this run figure; the full service counter is 203,035,309 bytes.

Bizapedia ended at 11/13 confirmed first-attempt passes on twelve observed exits. One visual challenge remained after its retry; another request ended in a client connection reset after 645.023 seconds. The runner then failed DNS lookup between requests.

After two corrections, those failures already prevent 19/20, so the batch was not restarted. Its known bytes average at least 2,653,034 per attempted page; the lost response has unknown route bytes.

This exceeds the half-baseline target of 1,496,712.65. Seven intended requests remain unmeasured.


## Bizapedia continuation measurements

### Persistent Bizapedia pilot, 4 November 2026

The interrupted five-page pilot recorded three payload passes on exit `99.129.196.41`. Cold page traffic was 3,542,524 bytes; pages two and three used 2,684,301 and 2,600,297 bytes. No fifth-page result was recorded.

The session ended at its residential budget after 305.841 seconds. Its settled total was 30,206,436 bytes, including traffic after the last completed observation. That total counts toward the 500 MB run ceiling.

| Host | Cold page bytes | Third page bytes |
| --- | ---: | ---: |
| challenges.cloudflare.com | 1,892,579 | 1,800,002 |
| ads.adthrive.com | 812,061 | 763,101 |
| www.bizapedia.com | 73,249 | 34,284 |
| launchpad-wrapper.privacymanager.io | 73,112 | 0 |
| g2.gumgum.com | 56,878 | 0 |
| btloader.com | 55,495 | 363 |
| prebid.production.adthrive.com | 52,940 | 0 |
| launchpad.privacymanager.io | 50,806 | 0 |
| Remaining measured traffic, hostname detail unavailable | 475,404 | 2,547 |

Persistent caching reduced several asset transfers, but Cloudflare traffic remained about 1.8 MB per page. This pilot does not meet the 1.50 MB target. The interrupted client produced no final traceback, so its interruption cause remains unresolved.

### Bizapedia same-browser HTML attempt

The second attempt loaded one browser page, then used `fetch` inside that same browser and proxy allocation for the next HTML document. It changed no host policy or image settings. Exit `24.166.88.211` returned 51 links on the first page; the next document returned HTTP 200 with a security-check interstitial and zero record links.

| Page | Method | Payloads | Measured bytes | Seconds |
| --- | --- | ---: | ---: | ---: |
| 1 | Browser | 51 | 2,919,305 | 35.358 |
| 2 | Same-browser fetch | 0 | 3,806,451 | 9.63 |

The settled total was 9,367,715 bytes. The ledger initially used the wrong key for the earlier pilot and raised `KeyError` after remote release; the key was corrected and the released session’s total was recovered from the API. This bookkeeping error did not leave the session open.

The two bandwidth approaches failed, so further optimization stopped under the owner’s limit. No new host refusals, direct hosts or image blocking were enabled. The fifth-page observation and twenty-session acceptance set remain uncompleted. Total settled residential traffic for these two pilots was 39,574,151 bytes.

The challenge handler deliberately stops when its isolated read classifies a visual puzzle; its supported actions cover checkboxes and the labelled drag fixture. A new-exit retry can therefore receive another puzzle without solving it. The surviving 645.023-second reset measurement records a client transport failure, but lacks the socket trace needed to identify the peer that closed it. The former client’s 300-second retry intervals explain much of the elapsed time; they do not establish the underlying network cause.

## Phase 4 completion and phase 5 measurements

The continuation has a separate 500,000,000-byte residential ceiling. Its initial admin ledger is 164,452,862 bytes; concurrent collectors use the separate `mosaic` key. The accepted phase 3 route table remains the bandwidth baseline.

The first local vault validation passed TypeScript and 30 tests, with two skipped, across six existing test files. The vault checks covered ciphertext, agent restrictions, reopen, tamper rejection and the RFC 6238 TOTP vector. A first typecheck used the repository root and printed compiler help; the next found an incorrect logger method name. The corrected code passed from `api/`. These checks establish no live site-login result.

The first timed direct set began at 17:08 UTC on 4 November. Four Anna attempts passed from Railway address `35.171.92.125`, with an interstitial observed. Its temporary state and process were absent at 17:37 UTC, so those four attempts remain pilot observations. The acceptance set restarted with state under `.state/direct-soak`, which is removed after measurements are recorded here.

### First direct batches, 4 November 2026

The declared set began at 17:38 UTC. Railway egress was `35.171.92.125`. The first batches completed with Anna 19/20, Utah 20/20 and Newspapers 20/20; all used zero residential bytes. Anna sample 12 returned HTTP 502 and no payload. A production deploy followed this first set. The owner later removed the timed waiting requirement.

| Route | Sample | Passed | Payloads | Seconds | Initial HTTP status | Interstitial observed |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| annas | 1 | yes | 116 | 13.865 | 403 | yes |
| annas | 2 | yes | 116 | 22.171 | 403 | yes |
| annas | 3 | yes | 116 | 14.167 | 403 | yes |
| annas | 4 | yes | 116 | 21.59 | 403 | yes |
| annas | 5 | yes | 116 | 18.204 | 403 | yes |
| annas | 6 | yes | 100 | 17.419 | 403 | yes |
| annas | 7 | yes | 116 | 15.682 | 403 | yes |
| annas | 8 | yes | 116 | 16.23 | 403 | yes |
| annas | 9 | yes | 116 | 17.331 | 403 | yes |
| annas | 10 | yes | 116 | 12.198 | 403 | yes |
| annas | 11 | yes | 116 | 20.682 | 403 | yes |
| annas | 12 | no | 0 | 60.691 | 502 | no |
| annas | 13 | yes | 116 | 16.814 | 403 | yes |
| annas | 14 | yes | 116 | 19.344 | 403 | yes |
| annas | 15 | yes | 116 | 11.991 | 403 | yes |
| annas | 16 | yes | 116 | 16.691 | 403 | yes |
| annas | 17 | yes | 116 | 13.13 | 403 | yes |
| annas | 18 | yes | 116 | 20.641 | 403 | yes |
| annas | 19 | yes | 116 | 17.296 | 403 | yes |
| annas | 20 | yes | 116 | 25.63 | 403 | yes |
| udn | 1 | yes | 50 | 0.719 | 418 | no |
| udn | 2 | yes | 50 | 0.711 | 418 | no |
| udn | 3 | yes | 50 | 0.764 | 418 | no |
| udn | 4 | yes | 50 | 0.77 | 418 | no |
| udn | 5 | yes | 50 | 0.81 | 418 | no |
| udn | 6 | yes | 50 | 0.794 | 418 | no |
| udn | 7 | yes | 50 | 0.811 | 418 | no |
| udn | 8 | yes | 50 | 0.713 | 418 | no |
| udn | 9 | yes | 50 | 0.774 | 418 | no |
| udn | 10 | yes | 50 | 0.751 | 418 | no |
| udn | 11 | yes | 50 | 0.716 | 418 | no |
| udn | 12 | yes | 50 | 0.747 | 418 | no |
| udn | 13 | yes | 50 | 0.796 | 418 | no |
| udn | 14 | yes | 50 | 0.77 | 418 | no |
| udn | 15 | yes | 50 | 0.786 | 418 | no |
| udn | 16 | yes | 50 | 0.765 | 418 | no |
| udn | 17 | yes | 50 | 0.81 | 418 | no |
| udn | 18 | yes | 50 | 0.774 | 418 | no |
| udn | 19 | yes | 50 | 0.729 | 418 | no |
| udn | 20 | yes | 50 | 0.74 | 418 | no |
| newspapers | 1 | yes | 2 | 0.669 | — | no |
| newspapers | 2 | yes | 2 | 0.635 | — | no |
| newspapers | 3 | yes | 2 | 0.643 | — | no |
| newspapers | 4 | yes | 2 | 0.74 | — | no |
| newspapers | 5 | yes | 2 | 0.607 | — | no |
| newspapers | 6 | yes | 2 | 0.593 | — | no |
| newspapers | 7 | yes | 2 | 0.625 | — | no |
| newspapers | 8 | yes | 2 | 0.611 | — | no |
| newspapers | 9 | yes | 2 | 0.642 | — | no |
| newspapers | 10 | yes | 2 | 0.62 | — | no |
| newspapers | 11 | yes | 2 | 0.649 | — | no |
| newspapers | 12 | yes | 2 | 0.592 | — | no |
| newspapers | 13 | yes | 2 | 0.58 | — | no |
| newspapers | 14 | yes | 2 | 0.636 | — | no |
| newspapers | 15 | yes | 2 | 0.762 | — | no |
| newspapers | 16 | yes | 2 | 0.744 | — | no |
| newspapers | 17 | yes | 2 | 0.63 | — | no |
| newspapers | 18 | yes | 2 | 0.638 | — | no |
| newspapers | 19 | yes | 2 | 0.799 | — | no |
| newspapers | 20 | yes | 2 | 0.921 | — | no |

### Vault and login acceptance to this point

The vault opened after deployment and imported three entries: Ancestry, Mary Ferrell and HathiTrust Google. A named collector key received metadata for all three and was denied a vault write. Two metadata responses and the inspected runtime log set contained zero known eight-character credential prefixes. Local vault checks cover encryption, authorization, reopening and tamper rejection. TypeScript passed; the latest focused files passed 22 tests with two skipped.

The first Ancestry call with an attached CDP client timed out at 120 seconds and settled 114,470 bytes. Service-only attempts then reached a filled form but returned `form_did_not_advance`; one settled 868,829 bytes and the repeated observation settled 873,067 bytes. A form-inspection session settled 425,147 bytes; an external CDP inspection timed out and settled 65,795 bytes.

After the first fix, Ancestry waited 122.435 seconds and returned `account_payload_missing`, with a disabled button and a retry control. That attempt settled 2,749,073 bytes. The second fix invokes the existing native challenge handler for verification inside the form; its failed live result is recorded below. The fixed sticky identity used `172.56.26.250` initially and `98.121.197.204` later, showing that the provider can replace an exit while retaining its sticky identifier.

Mary Ferrell signed in from the vault on a fresh identity without a device check. Its authenticated page showed My Membership and Sign Out; the session settled 1,860,995 bytes on `174.161.210.9`. A new canonical identity on `68.131.61.24` initially failed while the Python client remained attached (113,747 bytes). Detaching that client during service login and reattaching afterward passed, using 1,834,974 bytes. The migrated caller reads no Mary Ferrell credential fields and uses the same residential allocation for authenticated PDFs.

The daily checker has recorded successful Mary Ferrell checks on both identities. The canonical identity’s first scheduled check settled 69,043 bytes. The seven-day observation remains pending. No Ancestry-family email, SMS or authenticator check has yet been reached, and no TOTP seed has been enrolled. Mailbox access was absent from the supplied environment.

The canonical Mary Ferrell caller also passed release/reopen and an authenticated page read on `68.131.61.24`, settling 87,598 bytes. The first scheduled check on the earlier Mary Ferrell identity settled 69,316 bytes.

### Forced direct failures and expiry

| Route | Same-request escalation | Rung 3 result | Settled residential bytes | After expiry |
| --- | --- | --- | ---: | --- |
| Anna | Injected rung 2 failure, then rung 3 allocation failed | No session after 20.016 seconds | 1,818 | Rung 2 passed with 100 payloads in 13.051 seconds |
| Utah | Injected rung 2 failure, then rung 3 passed | 50 payloads in 7.093 seconds, exit 98.238.208.246 | 201,356 | Rung 2 passed with 50 payloads in 5.595 seconds |
| Newspapers | Injected rungs 1 and 2, then rung 3 passed | 2 form controls in 1.795 seconds, exit 76.171.18.175 | 907,358 | Rung 1 passed with 2 form controls in 0.396 seconds |

Each table entry moved to rung 3 and was checked 17 seconds later under a 15-second test TTL. Utah and Newspapers returned to their configured direct rungs. Anna’s failed allocation made its escalation check fail, so its production start was returned to rung 3. The successful retry after the allocation-loop correction is recorded below.

The imported env service names without supplied passwords were `E_YEARBOOK_EMAIL`, `ACADEMIA_EMAIL`, `DPIA_EMAIL` and `INKITT_USERNAME`; no vault entries were invented for them. All original login env fields remain because Ancestry-family and HathiTrust callers have not completed migration. HathiTrust Google login is unimplemented; a Google check has not been observed.

The second Ancestry fix returned `account_payload_missing` after 122.304 seconds on `98.121.197.204`, settling 2,233,799 bytes. The form still showed a disabled control and a retry label. Work on that failing item stopped after the two fixes. Newspapers and Fold3 new-device demands remain unobserved because the root login has not passed. Their CLI login commands now call the vault; their collection-session migration remains incomplete.

Mary Ferrell survived the `447c2b4` production deployment on the same `68.131.61.24` exit. An intentional sign-out was confirmed, but automatic re-login then returned `account_payload_missing`; the authenticated request check consequently failed despite HTTP 200. This failed check is separate from the earlier successful fresh login and reopen.

Anna’s post-fix escalation passed in one request: the injected rung 2 failure was followed by 116 payloads at rung 3 in 20.102 seconds on `71.117.146.211`. The transfer reported 2,227,454 bytes; the settled session total was 2,324,807. After the test TTL, rung 2 passed with 116 payloads in 14.517 seconds. Production remains configured at rung 3 while volume acceptance is pending.

The canonical Bizapedia caller opened and released its new persistent identity successfully, settling 28,583 bytes. This check loaded no Bizapedia page and adds no bandwidth-acceptance pass.

The Mary Ferrell post-deploy logout/relogin session settled 141,663 bytes. Two service-only observations also failed after 121.960 and 121.824 seconds, settling 83,210 and 84,097 bytes. A form inspection settled 69,100 bytes and confirmed visible username/password fields and an enabled SIGN IN button. The second fix activates Mary Ferrell’s primary tab before native input; its failed acceptance result is recorded below.

Railway’s static outbound setting was read through the CLI on 4 November: disabled, with no assigned static addresses. The recorded direct observations have used `35.171.92.125`; this establishes the observed address, not a permanent assignment. Railway documents permanent outbound addresses as an optional service setting and says its current static offering balances traffic over multiple addresses ([Static Outbound IPs](https://docs.railway.com/networking/static-outbound-ips)). No networking setting was changed.

The same-egress HTTP helper check returned HTTP 200 and matched the browser’s `98.159.24.143` exit, settling 80,917 bytes. Newspapers and Fold3 now use that helper for authenticated JSON requests. An initial local decoding check found a missing `base64` import; after correction, decoding, Python parsing and the affected CLI help checks passed.

A repeated known-prefix scan covered two metadata responses and two deployment log sets and reported no credential-prefix leak. The most recent typecheck and focused secret-handling file passed seven tests.

### Interrupted Anna volume attempt

The first 13 pages all returned payloads from `35.171.92.125` on build `279f404`; page 1 showed a challenge. That fails the volume criterion, so Anna remains at rung 3. The run was interrupted to roll back a login adapter error. Its observations remain below; the later attempt stopped after 114 reads because the route had failed.

| Page | Passed | Payloads | Seconds | Initial HTTP status | Challenge |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | yes | 100 | 16.476 | 403 | yes |
| 2 | yes | 116 | 13.472 | 200 | no |
| 3 | yes | 116 | 3.015 | 200 | no |
| 4 | yes | 116 | 1.827 | 200 | no |
| 5 | yes | 116 | 11.175 | 200 | no |
| 6 | yes | 116 | 4.001 | 200 | no |
| 7 | yes | 116 | 2.336 | 200 | no |
| 8 | yes | 116 | 3.259 | 200 | no |
| 9 | yes | 116 | 4.351 | 200 | no |
| 10 | yes | 116 | 8.062 | 200 | no |
| 11 | yes | 116 | 6.494 | 200 | no |
| 12 | yes | 116 | 3.534 | 200 | no |
| 13 | yes | 116 | 2.22 | 200 | no |

Mary Ferrell’s native-tab attempt initially returned HTTP 500 because the quiet-browser adapter lacked `bringToFront`. Production was rolled back to the verified `447c2b4` build after all sessions closed; health and a fresh quiet-session read passed. The missing adapter method was implemented, and the device-check flag was restricted to actual verification classifications. TypeScript and the two focused files passed 12 tests with two skipped. Its failed live result is recorded below.

The interrupted runner released its remote browser with zero residential bytes. Its local driver then stalled during disposal, so only that finite runner’s process group was ended after release. Only the acceptance runner’s local process group was explicitly ended. The original batch start and all measurements remain preserved.

The completed quiet-adapter correction deployed as `b2da0b3` and passed health, vault-open and fresh quiet-session page reads. The resume helper also preserves an earlier batch’s completion timestamp instead of rewriting it when a stopped process resumes.

The completed second Mary Ferrell fix still returned `account_payload_missing` on `68.131.61.24`. Its session settled 94,270 bytes over 614.683 seconds from creation to release; that duration includes the client’s waits and reconnection. The preceding adapter-error session settled 71,105 bytes. Work on automatic re-login stopped after the two fixes. Earlier successful sign-in and release/reopen/deploy observations do not establish reliable recovery after logout.

Settled residential use through these checks is 55,028,288 bytes: 52,437,072 on the administrative test key and 2,591,216 in identified acceptance and daily-check sessions on the collector key. Concurrent collector traffic is excluded. Only `VAULT_KEY` was added to Railway; no volume, proxy tier, static-IP or networking setting changed.

### Resumed Anna volume observations

This attempt on `b2da0b3` stopped at 114 reads after failing the challenge criterion. Railway egress was `35.171.92.125`. The remaining observations are reconciled below.

| Read | Query | Page | Passed | Payloads | Seconds | Initial HTTP status | Challenge |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| 1 | history | 1 | yes | 116 | 15.277 | 403 | yes |
| 2 | history | 2 | yes | 116 | 2.797 | 200 | no |
| 3 | history | 3 | yes | 116 | 2.405 | 200 | no |
| 4 | history | 4 | yes | 116 | 7.794 | 200 | no |
| 5 | history | 5 | yes | 116 | 6.369 | 200 | no |
| 6 | history | 6 | yes | 116 | 6.081 | 200 | no |
| 7 | history | 7 | yes | 116 | 1.737 | 200 | no |
| 8 | history | 8 | yes | 116 | 3.035 | 200 | no |
| 9 | history | 9 | yes | 116 | 1.841 | 200 | no |
| 10 | history | 10 | yes | 116 | 8.11 | 200 | no |
| 11 | history | 11 | no | 0 | 4.395 | — | no |
| 12 | history | 12 | yes | 116 | 4.727 | 200 | no |
| 13 | history | 13 | no | 0 | 3.467 | — | no |
| 14 | history | 14 | yes | 116 | 2.011 | 200 | no |
| 15 | history | 15 | yes | 116 | 2.718 | 200 | no |
| 16 | history | 16 | no | 0 | 1.489 | — | no |
| 17 | history | 17 | yes | 116 | 5.286 | 200 | no |
| 18 | history | 18 | yes | 116 | 7.646 | 200 | no |
| 19 | history | 19 | yes | 116 | 6.274 | 200 | no |
| 20 | history | 20 | yes | 116 | 9.778 | 200 | no |
| 21 | science | 1 | yes | 116 | 7.863 | 200 | no |
| 22 | science | 2 | yes | 116 | 2.609 | 200 | no |
| 23 | science | 3 | yes | 116 | 3.524 | 200 | no |
| 24 | science | 4 | yes | 116 | 2.2 | 200 | no |
| 25 | science | 5 | yes | 116 | 2.238 | 200 | no |
| 26 | science | 6 | yes | 116 | 7.455 | 200 | no |
| 27 | science | 7 | yes | 116 | 3.289 | 200 | no |
| 28 | science | 8 | yes | 116 | 2.172 | 200 | no |
| 29 | science | 9 | yes | 116 | 2.826 | 200 | no |
| 30 | science | 10 | yes | 116 | 2.44 | 200 | no |
| 31 | science | 11 | yes | 116 | 5.563 | 200 | no |
| 32 | science | 12 | yes | 116 | 2.14 | 200 | no |
| 33 | science | 13 | yes | 116 | 5.382 | 200 | no |
| 34 | science | 14 | yes | 116 | 3.6 | 200 | no |
| 35 | science | 15 | yes | 116 | 5.145 | 200 | no |
| 36 | science | 16 | yes | 116 | 5.619 | 200 | no |
| 37 | science | 17 | yes | 116 | 4.422 | 200 | no |
| 38 | science | 18 | yes | 116 | 2.843 | 200 | no |
| 39 | science | 19 | yes | 116 | 5.577 | 200 | no |
| 40 | science | 20 | yes | 116 | 4.528 | 200 | no |
| 41 | war | 1 | yes | 116 | 3.051 | 200 | no |
| 42 | war | 2 | yes | 116 | 4.325 | 200 | no |
| 43 | war | 3 | yes | 116 | 4.175 | 200 | no |
| 44 | war | 4 | yes | 116 | 4.078 | 200 | no |
| 45 | war | 5 | yes | 116 | 2.061 | 200 | no |
| 46 | war | 6 | yes | 116 | 1.957 | 200 | no |
| 47 | war | 7 | yes | 116 | 2.042 | 200 | no |
| 48 | war | 8 | yes | 116 | 2.039 | 200 | no |
| 49 | war | 9 | yes | 116 | 1.875 | 200 | no |
| 50 | war | 10 | yes | 116 | 2.046 | 200 | no |

### Immediate completion of the direct checks

On 4 November the owner withdrew the 24-hour waiting requirement. The timed runner was stopped after releasing its browser with zero residential bytes. Anna had already failed, so it remains at rung 3. The remaining Utah and Newspapers checks ran back-to-back with collector pacing. Their completed results are recorded below.

## Immediate direct-route result

The 24-hour requirement was withdrawn by the owner. Remaining checks ran immediately, with Utah and Newspapers measured concurrently on separate browser sessions. These results establish the measured short-run behavior; long-term stability remains unverified.

| Route | Batch passes, out of 20 each | Volume payload passes | Challenges observed | First 20 median, s | Last 20 median, s | P95, s |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| annas | 19 | 111/114 | 2 | 4.561 | 2.173 | 7.794 |
| udn | 20, 20, 20, 20 | 200/200 | 0 | 1.289 | 1.627 | 1.716 |
| newspapers | 20, 20, 19, 20 | 200/200 | 0 | 0.619 | 0.655 | 0.795 |

All forced-escalation and expiry checks passed. Anna remains configured at rung 3 after its volume failure. The direct measurements used zero residential bytes. Observed Railway egress addresses: `35.171.92.125`.

Newspapers batch 3 had one unavailable-page response with no form payload; its 19/20 result meets the batch threshold. The completed volume check had no failed payloads.

Utah remains at starting rung 2 and the Newspapers sign-in page at rung 1. The initial batches used a fresh browser per read; after the API cache interruption, the remaining batches reused one browser per batch.

The volume checks used one browser allocation per route and two seconds of parsing time between reads. Utah read search pages 1–200 for `war`, requesting 50 results per page; Newspapers repeated its sign-in form.

| Route and batch | Started, UTC | Completed, UTC |
| --- | --- | --- |
| annas 1 | 2026-11-04T17:38:45.355584+00:00 | 2026-11-04T17:47:05.175234+00:00 |
| newspapers 1 | 2026-11-04T17:48:55.818401+00:00 | 2026-11-04T17:50:29.060627+00:00 |
| newspapers 2 | 2026-11-04T19:22:02.206548+00:00 | 2026-11-04T19:23:02.052732+00:00 |
| newspapers 3 | 2026-11-04T19:23:02.053835+00:00 | 2026-11-04T19:23:57.135320+00:00 |
| newspapers 4 | 2026-11-04T19:23:57.136108+00:00 | 2026-11-04T19:24:53.086534+00:00 |
| udn 1 | 2026-11-04T17:47:05.175743+00:00 | 2026-11-04T17:48:55.817893+00:00 |
| udn 2 | 2026-11-04T19:08:55.609168+00:00 | 2026-11-04T19:13:46.014678+00:00 |
| udn 3 | 2026-11-04T19:13:46.015482+00:00 | 2026-11-04T19:14:40.005005+00:00 |
| udn 4 | 2026-11-04T19:14:40.006555+00:00 | 2026-11-04T19:15:35.529399+00:00 |

The first batches ran on `f019e09`; remaining completed batches ran on `b2da0b3`, satisfying the redeploy-between-batches check.

The earlier 13-read interrupted Anna attempt also observed a challenge and remains recorded above. No further Anna batches were run after its failure. For HTTP probes, the challenge flag means a failed payload check; it includes unavailable-page responses and does not by itself identify a bot challenge.

### Remaining Anna volume observations

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 51 | 2026-11-04T18:50:09.423960+00:00 | 116 | 4.564 | 200 | 2 | — | no | pass |
| 52 | 2026-11-04T18:50:15.994160+00:00 | 116 | 1.899 | 200 | 2 | — | no | pass |
| 53 | 2026-11-04T18:50:19.899232+00:00 | 116 | 2.004 | 200 | 2 | — | no | pass |
| 54 | 2026-11-04T18:50:23.911056+00:00 | 116 | 1.889 | 200 | 2 | — | no | pass |
| 55 | 2026-11-04T18:50:27.805569+00:00 | 116 | 1.947 | 200 | 2 | — | no | pass |
| 56 | 2026-11-04T18:50:31.753990+00:00 | 116 | 1.863 | 200 | 2 | — | no | pass |
| 57 | 2026-11-04T18:50:35.622072+00:00 | 116 | 1.892 | 200 | 2 | — | no | pass |
| 58 | 2026-11-04T18:50:39.518624+00:00 | 116 | 1.863 | 200 | 2 | — | no | pass |
| 59 | 2026-11-04T18:50:43.387545+00:00 | 116 | 2.09 | 200 | 2 | — | no | pass |
| 60 | 2026-11-04T18:50:47.482737+00:00 | 116 | 4.716 | 200 | 2 | — | no | pass |
| 61 | 2026-11-04T18:50:54.202267+00:00 | 116 | 1.754 | 200 | 2 | — | no | pass |
| 62 | 2026-11-04T18:50:57.957791+00:00 | 116 | 1.866 | 200 | 2 | — | no | pass |
| 63 | 2026-11-04T18:51:01.829130+00:00 | 116 | 1.838 | 200 | 2 | — | no | pass |
| 64 | 2026-11-04T18:51:05.669620+00:00 | 116 | 1.98 | 200 | 2 | — | no | pass |
| 65 | 2026-11-04T18:51:09.652850+00:00 | 116 | 4.424 | 200 | 2 | — | no | pass |
| 66 | 2026-11-04T18:51:16.082821+00:00 | 116 | 1.997 | 200 | 2 | — | no | pass |
| 67 | 2026-11-04T18:51:20.085204+00:00 | 116 | 2.142 | 200 | 2 | — | no | pass |
| 68 | 2026-11-04T18:51:24.233382+00:00 | 116 | 2.116 | 200 | 2 | — | no | pass |
| 69 | 2026-11-04T18:51:28.350937+00:00 | 116 | 3.746 | 200 | 2 | — | no | pass |
| 70 | 2026-11-04T18:51:34.101847+00:00 | 116 | 3.253 | 200 | 2 | — | no | pass |
| 71 | 2026-11-04T18:51:39.360548+00:00 | 116 | 1.893 | 200 | 2 | — | no | pass |
| 72 | 2026-11-04T18:51:43.258773+00:00 | 116 | 3.614 | 200 | 2 | — | no | pass |
| 73 | 2026-11-04T18:51:48.878317+00:00 | 116 | 2.032 | 200 | 2 | — | no | pass |
| 74 | 2026-11-04T18:51:52.914954+00:00 | 116 | 1.73 | 200 | 2 | — | no | pass |
| 75 | 2026-11-04T18:51:56.654673+00:00 | 116 | 1.992 | 200 | 2 | — | no | pass |
| 76 | 2026-11-04T18:52:00.651045+00:00 | 116 | 1.664 | 200 | 2 | — | no | pass |
| 77 | 2026-11-04T18:52:04.321277+00:00 | 116 | 4.434 | 200 | 2 | — | no | pass |
| 78 | 2026-11-04T18:52:10.759946+00:00 | 116 | 2.1 | 200 | 2 | — | no | pass |
| 79 | 2026-11-04T18:52:14.865219+00:00 | 116 | 1.784 | 200 | 2 | — | no | pass |
| 80 | 2026-11-04T18:52:18.652717+00:00 | 116 | 3.56 | 200 | 2 | — | no | pass |
| 81 | 2026-11-04T18:52:24.216515+00:00 | 116 | 2.496 | 200 | 2 | — | no | pass |
| 82 | 2026-11-04T18:52:28.718030+00:00 | 116 | 5.035 | 200 | 2 | — | no | pass |
| 83 | 2026-11-04T18:52:35.755876+00:00 | 116 | 2.109 | 200 | 2 | — | no | pass |
| 84 | 2026-11-04T18:52:39.870121+00:00 | 116 | 2.638 | 200 | 2 | — | no | pass |
| 85 | 2026-11-04T18:52:44.510670+00:00 | 116 | 2.031 | 200 | 2 | — | no | pass |
| 86 | 2026-11-04T18:52:48.547703+00:00 | 116 | 1.9 | 200 | 2 | — | no | pass |
| 87 | 2026-11-04T18:52:52.453360+00:00 | 116 | 3.786 | 200 | 2 | — | no | pass |
| 88 | 2026-11-04T18:52:58.255466+00:00 | 116 | 2.407 | 200 | 2 | — | no | pass |
| 89 | 2026-11-04T18:53:02.667323+00:00 | 116 | 9.821 | 403 | 2 | — | yes | pass |
| 90 | 2026-11-04T18:53:14.492431+00:00 | 116 | 3.749 | 200 | 2 | — | no | pass |
| 91 | 2026-11-04T18:53:20.246578+00:00 | 116 | 4.318 | 200 | 2 | — | no | pass |
| 92 | 2026-11-04T18:53:26.568291+00:00 | 116 | 2.238 | 200 | 2 | — | no | pass |
| 93 | 2026-11-04T18:53:30.810590+00:00 | 116 | 2.569 | 200 | 2 | — | no | pass |
| 94 | 2026-11-04T18:53:35.384622+00:00 | 116 | 3.392 | 200 | 2 | — | no | pass |
| 95 | 2026-11-04T18:53:40.782024+00:00 | 116 | 2.073 | 200 | 2 | — | no | pass |
| 96 | 2026-11-04T18:53:44.856170+00:00 | 116 | 2.104 | 200 | 2 | — | no | pass |
| 97 | 2026-11-04T18:53:48.966553+00:00 | 116 | 2.024 | 200 | 2 | — | no | pass |
| 98 | 2026-11-04T18:53:52.996291+00:00 | 116 | 4.11 | 200 | 2 | — | no | pass |
| 99 | 2026-11-04T18:53:59.112741+00:00 | 116 | 2.133 | 200 | 2 | — | no | pass |
| 100 | 2026-11-04T18:54:03.248880+00:00 | 116 | 2.306 | 200 | 2 | — | no | pass |
| 101 | 2026-11-04T18:54:07.559356+00:00 | 116 | 2.154 | 200 | 2 | — | no | pass |
| 102 | 2026-11-04T18:54:11.719401+00:00 | 116 | 4.548 | 200 | 2 | — | no | pass |
| 103 | 2026-11-04T18:54:18.272725+00:00 | 116 | 2.07 | 200 | 2 | — | no | pass |
| 104 | 2026-11-04T18:54:22.346476+00:00 | 116 | 4.045 | 200 | 2 | — | no | pass |
| 105 | 2026-11-04T18:54:28.396425+00:00 | 116 | 1.904 | 200 | 2 | — | no | pass |
| 106 | 2026-11-04T18:54:32.302370+00:00 | 116 | 2.057 | 200 | 2 | — | no | pass |
| 107 | 2026-11-04T18:54:36.364570+00:00 | 116 | 1.974 | 200 | 2 | — | no | pass |
| 108 | 2026-11-04T18:54:40.344107+00:00 | 116 | 3.791 | 200 | 2 | — | no | pass |
| 109 | 2026-11-04T18:54:46.137000+00:00 | 116 | 3.423 | 200 | 2 | — | no | pass |
| 110 | 2026-11-04T18:54:51.564621+00:00 | 116 | 2.192 | 200 | 2 | — | no | pass |
| 111 | 2026-11-04T18:54:55.761561+00:00 | 116 | 3.379 | 200 | 2 | — | no | pass |
| 112 | 2026-11-04T18:55:01.143725+00:00 | 116 | 2.121 | 200 | 2 | — | no | pass |
| 113 | 2026-11-04T18:55:05.267055+00:00 | 116 | 2.231 | 200 | 2 | — | no | pass |
| 114 | 2026-11-04T18:55:09.499559+00:00 | 116 | 2.276 | 200 | 2 | — | no | pass |

A prior Newspapers volume attempt returned 108 payloads before Steel rejected the next request with HTTP 429. The failure occurred at the API; its response body was not retained. The API’s 128-entry, ten-minute idempotency cache is the likely cause. A later diagnostic HTTP read passed. Read-only probes were changed to omit mutation-cache keys, and remaining batches reuse one browser session.

### Interrupted Newspapers volume observations

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:00:41.257783+00:00 | 2 | 0.637 | — | 1 | 613282 | no | pass |
| 2 | 2026-11-04T19:00:43.940714+00:00 | 2 | 0.678 | — | 1 | 613282 | no | pass |
| 3 | 2026-11-04T19:00:46.613678+00:00 | 2 | 0.668 | — | 1 | 613282 | no | pass |
| 4 | 2026-11-04T19:00:49.299217+00:00 | 2 | 0.68 | — | 1 | 613285 | no | pass |
| 5 | 2026-11-04T19:00:51.956326+00:00 | 2 | 0.654 | — | 1 | 613282 | no | pass |
| 6 | 2026-11-04T19:00:54.579816+00:00 | 2 | 0.621 | — | 1 | 613282 | no | pass |
| 7 | 2026-11-04T19:00:57.200887+00:00 | 2 | 0.617 | — | 1 | 613283 | no | pass |
| 8 | 2026-11-04T19:00:59.886670+00:00 | 2 | 0.682 | — | 1 | 613282 | no | pass |
| 9 | 2026-11-04T19:01:02.566212+00:00 | 2 | 0.678 | — | 1 | 613283 | no | pass |
| 10 | 2026-11-04T19:01:05.189683+00:00 | 2 | 0.618 | — | 1 | 613284 | no | pass |
| 11 | 2026-11-04T19:01:07.883790+00:00 | 2 | 0.693 | — | 1 | 613283 | no | pass |
| 12 | 2026-11-04T19:01:10.550102+00:00 | 2 | 0.665 | — | 1 | 613283 | no | pass |
| 13 | 2026-11-04T19:01:13.439668+00:00 | 2 | 0.886 | — | 1 | 613282 | no | pass |
| 14 | 2026-11-04T19:01:16.058320+00:00 | 2 | 0.613 | — | 1 | 613283 | no | pass |
| 15 | 2026-11-04T19:01:18.756169+00:00 | 2 | 0.693 | — | 1 | 613283 | no | pass |
| 16 | 2026-11-04T19:01:21.364926+00:00 | 2 | 0.608 | — | 1 | 613282 | no | pass |
| 17 | 2026-11-04T19:01:24.038944+00:00 | 2 | 0.669 | — | 1 | 613284 | no | pass |
| 18 | 2026-11-04T19:01:26.639650+00:00 | 2 | 0.598 | — | 1 | 613283 | no | pass |
| 19 | 2026-11-04T19:01:29.255208+00:00 | 2 | 0.611 | — | 1 | 613282 | no | pass |
| 20 | 2026-11-04T19:01:31.915425+00:00 | 2 | 0.657 | — | 1 | 613284 | no | pass |
| 21 | 2026-11-04T19:01:34.665805+00:00 | 2 | 0.745 | — | 1 | 613282 | no | pass |
| 22 | 2026-11-04T19:01:37.296317+00:00 | 2 | 0.63 | — | 1 | 613283 | no | pass |
| 23 | 2026-11-04T19:01:39.940443+00:00 | 2 | 0.643 | — | 1 | 613284 | no | pass |
| 24 | 2026-11-04T19:01:42.548921+00:00 | 2 | 0.603 | — | 1 | 613283 | no | pass |
| 25 | 2026-11-04T19:01:45.121873+00:00 | 2 | 0.572 | — | 1 | 613283 | no | pass |
| 26 | 2026-11-04T19:01:47.813435+00:00 | 2 | 0.689 | — | 1 | 613282 | no | pass |
| 27 | 2026-11-04T19:01:50.394242+00:00 | 2 | 0.575 | — | 1 | 613285 | no | pass |
| 28 | 2026-11-04T19:01:53.002166+00:00 | 2 | 0.603 | — | 1 | 613285 | no | pass |
| 29 | 2026-11-04T19:01:55.609513+00:00 | 2 | 0.602 | — | 1 | 613284 | no | pass |
| 30 | 2026-11-04T19:01:58.197376+00:00 | 2 | 0.587 | — | 1 | 613283 | no | pass |
| 31 | 2026-11-04T19:02:00.836188+00:00 | 2 | 0.633 | — | 1 | 613284 | no | pass |
| 32 | 2026-11-04T19:02:03.442390+00:00 | 2 | 0.601 | — | 1 | 613282 | no | pass |
| 33 | 2026-11-04T19:02:06.047637+00:00 | 2 | 0.6 | — | 1 | 613283 | no | pass |
| 34 | 2026-11-04T19:02:08.640062+00:00 | 2 | 0.587 | — | 1 | 613282 | no | pass |
| 35 | 2026-11-04T19:02:11.314501+00:00 | 2 | 0.669 | — | 1 | 613285 | no | pass |
| 36 | 2026-11-04T19:02:13.900993+00:00 | 2 | 0.581 | — | 1 | 613282 | no | pass |
| 37 | 2026-11-04T19:02:16.500144+00:00 | 2 | 0.594 | — | 1 | 613283 | no | pass |
| 38 | 2026-11-04T19:02:19.146184+00:00 | 2 | 0.646 | — | 1 | 613284 | no | pass |
| 39 | 2026-11-04T19:02:21.798713+00:00 | 2 | 0.651 | — | 1 | 613282 | no | pass |
| 40 | 2026-11-04T19:02:24.382158+00:00 | 2 | 0.582 | — | 1 | 613284 | no | pass |
| 41 | 2026-11-04T19:02:27.074528+00:00 | 2 | 0.687 | — | 1 | 613285 | no | pass |
| 42 | 2026-11-04T19:02:29.678199+00:00 | 2 | 0.603 | — | 1 | 613285 | no | pass |
| 43 | 2026-11-04T19:02:32.361968+00:00 | 2 | 0.679 | — | 1 | 613282 | no | pass |
| 44 | 2026-11-04T19:02:34.974330+00:00 | 2 | 0.608 | — | 1 | 613284 | no | pass |
| 45 | 2026-11-04T19:02:37.614738+00:00 | 2 | 0.639 | — | 1 | 613285 | no | pass |
| 46 | 2026-11-04T19:02:40.179925+00:00 | 2 | 0.565 | — | 1 | 613283 | no | pass |
| 47 | 2026-11-04T19:02:42.747540+00:00 | 2 | 0.564 | — | 1 | 613284 | no | pass |
| 48 | 2026-11-04T19:02:45.356525+00:00 | 2 | 0.604 | — | 1 | 613283 | no | pass |
| 49 | 2026-11-04T19:02:48.013042+00:00 | 2 | 0.653 | — | 1 | 613283 | no | pass |
| 50 | 2026-11-04T19:02:50.626937+00:00 | 2 | 0.608 | — | 1 | 613283 | no | pass |
| 51 | 2026-11-04T19:02:53.285146+00:00 | 2 | 0.655 | — | 1 | 613282 | no | pass |
| 52 | 2026-11-04T19:02:55.930438+00:00 | 2 | 0.641 | — | 1 | 613284 | no | pass |
| 53 | 2026-11-04T19:02:58.628140+00:00 | 2 | 0.692 | — | 1 | 613284 | no | pass |
| 54 | 2026-11-04T19:03:01.265970+00:00 | 2 | 0.632 | — | 1 | 613285 | no | pass |
| 55 | 2026-11-04T19:03:03.851992+00:00 | 2 | 0.585 | — | 1 | 613282 | no | pass |
| 56 | 2026-11-04T19:03:06.678130+00:00 | 2 | 0.82 | — | 1 | 613284 | no | pass |
| 57 | 2026-11-04T19:03:09.364073+00:00 | 2 | 0.68 | — | 1 | 613283 | no | pass |
| 58 | 2026-11-04T19:03:11.980733+00:00 | 2 | 0.612 | — | 1 | 613282 | no | pass |
| 59 | 2026-11-04T19:03:14.613294+00:00 | 2 | 0.631 | — | 1 | 613282 | no | pass |
| 60 | 2026-11-04T19:03:17.272673+00:00 | 2 | 0.653 | — | 1 | 613283 | no | pass |
| 61 | 2026-11-04T19:03:19.907660+00:00 | 2 | 0.634 | — | 1 | 613282 | no | pass |
| 62 | 2026-11-04T19:03:22.612392+00:00 | 2 | 0.699 | — | 1 | 613282 | no | pass |
| 63 | 2026-11-04T19:03:25.218335+00:00 | 2 | 0.6 | — | 1 | 613282 | no | pass |
| 64 | 2026-11-04T19:03:27.861787+00:00 | 2 | 0.639 | — | 1 | 613283 | no | pass |
| 65 | 2026-11-04T19:03:30.659538+00:00 | 2 | 0.796 | — | 1 | 613282 | no | pass |
| 66 | 2026-11-04T19:03:33.293491+00:00 | 2 | 0.631 | — | 1 | 613284 | no | pass |
| 67 | 2026-11-04T19:03:35.948594+00:00 | 2 | 0.649 | — | 1 | 613282 | no | pass |
| 68 | 2026-11-04T19:03:38.724758+00:00 | 2 | 0.77 | — | 1 | 613283 | no | pass |
| 69 | 2026-11-04T19:03:41.479120+00:00 | 2 | 0.748 | — | 1 | 613282 | no | pass |
| 70 | 2026-11-04T19:03:44.123593+00:00 | 2 | 0.641 | — | 1 | 613282 | no | pass |
| 71 | 2026-11-04T19:03:46.735763+00:00 | 2 | 0.61 | — | 1 | 613285 | no | pass |
| 72 | 2026-11-04T19:03:49.359279+00:00 | 2 | 0.62 | — | 1 | 613282 | no | pass |
| 73 | 2026-11-04T19:03:51.981446+00:00 | 2 | 0.617 | — | 1 | 613282 | no | pass |
| 74 | 2026-11-04T19:03:54.635546+00:00 | 2 | 0.648 | — | 1 | 613283 | no | pass |
| 75 | 2026-11-04T19:03:57.273171+00:00 | 2 | 0.636 | — | 1 | 613283 | no | pass |
| 76 | 2026-11-04T19:04:00.047502+00:00 | 2 | 0.772 | — | 1 | 613283 | no | pass |
| 77 | 2026-11-04T19:04:02.763511+00:00 | 2 | 0.71 | — | 1 | 613282 | no | pass |
| 78 | 2026-11-04T19:04:05.397716+00:00 | 2 | 0.628 | — | 1 | 613284 | no | pass |
| 79 | 2026-11-04T19:04:08.063296+00:00 | 2 | 0.663 | — | 1 | 613283 | no | pass |
| 80 | 2026-11-04T19:04:10.679892+00:00 | 2 | 0.61 | — | 1 | 613284 | no | pass |
| 81 | 2026-11-04T19:04:13.297434+00:00 | 2 | 0.615 | — | 1 | 613283 | no | pass |
| 82 | 2026-11-04T19:04:15.917441+00:00 | 2 | 0.615 | — | 1 | 613282 | no | pass |
| 83 | 2026-11-04T19:04:18.561190+00:00 | 2 | 0.638 | — | 1 | 613282 | no | pass |
| 84 | 2026-11-04T19:04:21.212996+00:00 | 2 | 0.647 | — | 1 | 613284 | no | pass |
| 85 | 2026-11-04T19:04:24.127377+00:00 | 2 | 0.911 | — | 1 | 613282 | no | pass |
| 86 | 2026-11-04T19:04:26.778488+00:00 | 2 | 0.648 | — | 1 | 613283 | no | pass |
| 87 | 2026-11-04T19:04:29.395481+00:00 | 2 | 0.615 | — | 1 | 613282 | no | pass |
| 88 | 2026-11-04T19:04:32.043702+00:00 | 2 | 0.642 | — | 1 | 613282 | no | pass |
| 89 | 2026-11-04T19:04:34.673961+00:00 | 2 | 0.624 | — | 1 | 613285 | no | pass |
| 90 | 2026-11-04T19:04:37.280514+00:00 | 2 | 0.601 | — | 1 | 613282 | no | pass |
| 91 | 2026-11-04T19:04:39.918506+00:00 | 2 | 0.632 | — | 1 | 613284 | no | pass |
| 92 | 2026-11-04T19:04:42.558151+00:00 | 2 | 0.638 | — | 1 | 613283 | no | pass |
| 93 | 2026-11-04T19:04:45.147429+00:00 | 2 | 0.585 | — | 1 | 613283 | no | pass |
| 94 | 2026-11-04T19:04:47.808596+00:00 | 2 | 0.656 | — | 1 | 613282 | no | pass |
| 95 | 2026-11-04T19:04:50.387233+00:00 | 2 | 0.573 | — | 1 | 613285 | no | pass |
| 96 | 2026-11-04T19:04:53.001141+00:00 | 2 | 0.609 | — | 1 | 613285 | no | pass |
| 97 | 2026-11-04T19:04:55.659013+00:00 | 2 | 0.652 | — | 1 | 613282 | no | pass |
| 98 | 2026-11-04T19:04:58.451217+00:00 | 2 | 0.791 | — | 1 | 613284 | no | pass |
| 99 | 2026-11-04T19:05:01.095054+00:00 | 2 | 0.639 | — | 1 | 613285 | no | pass |
| 100 | 2026-11-04T19:05:03.710120+00:00 | 2 | 0.61 | — | 1 | 613283 | no | pass |
| 101 | 2026-11-04T19:05:06.355224+00:00 | 2 | 0.64 | — | 1 | 613284 | no | pass |
| 102 | 2026-11-04T19:05:09.014123+00:00 | 2 | 0.653 | — | 1 | 613282 | no | pass |
| 103 | 2026-11-04T19:05:11.837146+00:00 | 2 | 0.821 | — | 1 | 613282 | no | pass |
| 104 | 2026-11-04T19:05:14.513243+00:00 | 2 | 0.671 | — | 1 | 613284 | no | pass |
| 105 | 2026-11-04T19:05:17.117704+00:00 | 2 | 0.601 | — | 1 | 613285 | no | pass |
| 106 | 2026-11-04T19:05:19.725928+00:00 | 2 | 0.603 | — | 1 | 613283 | no | pass |
| 107 | 2026-11-04T19:05:22.419360+00:00 | 2 | 0.687 | — | 1 | 613284 | no | pass |
| 108 | 2026-11-04T19:05:25.073347+00:00 | 2 | 0.652 | — | 1 | 613283 | no | pass |

### udn volume observations

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T18:57:15.997523+00:00 | 100 | 4.767 | 418 | 2 | — | no | pass |
| 2 | 2026-11-04T18:57:22.768622+00:00 | 100 | 1.38 | 200 | 2 | — | no | pass |
| 3 | 2026-11-04T18:57:26.154840+00:00 | 100 | 1.364 | 200 | 2 | — | no | pass |
| 4 | 2026-11-04T18:57:29.520465+00:00 | 100 | 1.23 | 200 | 2 | — | no | pass |
| 5 | 2026-11-04T18:57:32.751609+00:00 | 100 | 1.27 | 200 | 2 | — | no | pass |
| 6 | 2026-11-04T18:57:36.025358+00:00 | 100 | 1.269 | 200 | 2 | — | no | pass |
| 7 | 2026-11-04T18:57:39.301306+00:00 | 100 | 1.465 | 200 | 2 | — | no | pass |
| 8 | 2026-11-04T18:57:42.772997+00:00 | 100 | 1.308 | 200 | 2 | — | no | pass |
| 9 | 2026-11-04T18:57:46.083841+00:00 | 100 | 1.416 | 200 | 2 | — | no | pass |
| 10 | 2026-11-04T18:57:49.505512+00:00 | 100 | 1.234 | 200 | 2 | — | no | pass |
| 11 | 2026-11-04T18:57:52.741777+00:00 | 100 | 1.363 | 200 | 2 | — | no | pass |
| 12 | 2026-11-04T18:57:56.109989+00:00 | 100 | 1.231 | 200 | 2 | — | no | pass |
| 13 | 2026-11-04T18:57:59.347769+00:00 | 100 | 1.211 | 200 | 2 | — | no | pass |
| 14 | 2026-11-04T18:58:02.563417+00:00 | 100 | 1.245 | 200 | 2 | — | no | pass |
| 15 | 2026-11-04T18:58:05.812914+00:00 | 100 | 1.27 | 200 | 2 | — | no | pass |
| 16 | 2026-11-04T18:58:09.088850+00:00 | 100 | 1.368 | 200 | 2 | — | no | pass |
| 17 | 2026-11-04T18:58:12.457504+00:00 | 100 | 1.412 | 200 | 2 | — | no | pass |
| 18 | 2026-11-04T18:58:15.872546+00:00 | 100 | 1.211 | 200 | 2 | — | no | pass |
| 19 | 2026-11-04T18:58:19.088104+00:00 | 100 | 1.247 | 200 | 2 | — | no | pass |
| 20 | 2026-11-04T18:58:22.336889+00:00 | 100 | 1.465 | 200 | 2 | — | no | pass |
| 21 | 2026-11-04T18:58:25.807410+00:00 | 100 | 1.206 | 200 | 2 | — | no | pass |
| 22 | 2026-11-04T18:58:29.016875+00:00 | 100 | 1.235 | 200 | 2 | — | no | pass |
| 23 | 2026-11-04T18:58:32.255327+00:00 | 100 | 1.269 | 200 | 2 | — | no | pass |
| 24 | 2026-11-04T18:58:35.529635+00:00 | 100 | 1.249 | 200 | 2 | — | no | pass |
| 25 | 2026-11-04T18:58:38.783776+00:00 | 100 | 1.303 | 200 | 2 | — | no | pass |
| 26 | 2026-11-04T18:58:42.089014+00:00 | 100 | 1.294 | 200 | 2 | — | no | pass |
| 27 | 2026-11-04T18:58:45.384458+00:00 | 100 | 1.219 | 200 | 2 | — | no | pass |
| 28 | 2026-11-04T18:58:48.609340+00:00 | 100 | 1.352 | 200 | 2 | — | no | pass |
| 29 | 2026-11-04T18:58:51.964112+00:00 | 100 | 1.224 | 200 | 2 | — | no | pass |
| 30 | 2026-11-04T18:58:55.189063+00:00 | 100 | 1.3 | 200 | 2 | — | no | pass |
| 31 | 2026-11-04T18:58:58.492766+00:00 | 100 | 1.207 | 200 | 2 | — | no | pass |
| 32 | 2026-11-04T18:59:01.701081+00:00 | 100 | 1.246 | 200 | 2 | — | no | pass |
| 33 | 2026-11-04T18:59:04.951115+00:00 | 100 | 1.304 | 200 | 2 | — | no | pass |
| 34 | 2026-11-04T18:59:08.260826+00:00 | 100 | 1.255 | 200 | 2 | — | no | pass |
| 35 | 2026-11-04T18:59:11.521872+00:00 | 100 | 1.265 | 200 | 2 | — | no | pass |
| 36 | 2026-11-04T18:59:14.789820+00:00 | 100 | 1.233 | 200 | 2 | — | no | pass |
| 37 | 2026-11-04T18:59:18.026050+00:00 | 100 | 1.362 | 200 | 2 | — | no | pass |
| 38 | 2026-11-04T18:59:21.393581+00:00 | 100 | 1.37 | 200 | 2 | — | no | pass |
| 39 | 2026-11-04T18:59:24.767652+00:00 | 100 | 1.42 | 200 | 2 | — | no | pass |
| 40 | 2026-11-04T18:59:28.189052+00:00 | 100 | 1.434 | 200 | 2 | — | no | pass |
| 41 | 2026-11-04T18:59:31.626010+00:00 | 100 | 1.379 | 200 | 2 | — | no | pass |
| 42 | 2026-11-04T18:59:35.010638+00:00 | 100 | 1.65 | 200 | 2 | — | no | pass |
| 43 | 2026-11-04T18:59:38.663708+00:00 | 100 | 1.444 | 200 | 2 | — | no | pass |
| 44 | 2026-11-04T18:59:42.113492+00:00 | 100 | 1.336 | 200 | 2 | — | no | pass |
| 45 | 2026-11-04T18:59:45.453839+00:00 | 100 | 1.317 | 200 | 2 | — | no | pass |
| 46 | 2026-11-04T18:59:48.776104+00:00 | 100 | 1.344 | 200 | 2 | — | no | pass |
| 47 | 2026-11-04T18:59:52.125888+00:00 | 100 | 1.287 | 200 | 2 | — | no | pass |
| 48 | 2026-11-04T18:59:55.413864+00:00 | 100 | 1.351 | 200 | 2 | — | no | pass |
| 49 | 2026-11-04T18:59:58.770787+00:00 | 100 | 1.371 | 200 | 2 | — | no | pass |
| 50 | 2026-11-04T19:00:02.147365+00:00 | 100 | 1.522 | 200 | 2 | — | no | pass |
| 51 | 2026-11-04T19:00:05.674728+00:00 | 100 | 1.286 | 200 | 2 | — | no | pass |
| 52 | 2026-11-04T19:00:08.966031+00:00 | 100 | 1.41 | 200 | 2 | — | no | pass |
| 53 | 2026-11-04T19:00:12.381283+00:00 | 100 | 2.761 | 200 | 2 | — | no | pass |
| 54 | 2026-11-04T19:00:17.144686+00:00 | 100 | 1.98 | 200 | 2 | — | no | pass |
| 55 | 2026-11-04T19:00:21.125854+00:00 | 100 | 1.251 | 200 | 2 | — | no | pass |
| 56 | 2026-11-04T19:00:24.382672+00:00 | 100 | 1.337 | 200 | 2 | — | no | pass |
| 57 | 2026-11-04T19:00:27.720807+00:00 | 100 | 1.255 | 200 | 2 | — | no | pass |
| 58 | 2026-11-04T19:00:30.980058+00:00 | 100 | 1.316 | 200 | 2 | — | no | pass |
| 59 | 2026-11-04T19:00:34.301810+00:00 | 100 | 1.561 | 200 | 2 | — | no | pass |
| 60 | 2026-11-04T19:00:37.867133+00:00 | 100 | 1.311 | 200 | 2 | — | no | pass |
| 61 | 2026-11-04T19:00:41.179277+00:00 | 100 | 1.468 | 200 | 2 | — | no | pass |
| 62 | 2026-11-04T19:00:44.653183+00:00 | 100 | 1.457 | 200 | 2 | — | no | pass |
| 63 | 2026-11-04T19:00:48.115097+00:00 | 100 | 1.449 | 200 | 2 | — | no | pass |
| 64 | 2026-11-04T19:00:51.567442+00:00 | 100 | 1.336 | 200 | 2 | — | no | pass |
| 65 | 2026-11-04T19:00:54.908573+00:00 | 100 | 1.257 | 200 | 2 | — | no | pass |
| 66 | 2026-11-04T19:00:58.171435+00:00 | 100 | 1.365 | 200 | 2 | — | no | pass |
| 67 | 2026-11-04T19:01:01.542177+00:00 | 100 | 1.406 | 200 | 2 | — | no | pass |
| 68 | 2026-11-04T19:01:04.954022+00:00 | 100 | 1.338 | 200 | 2 | — | no | pass |
| 69 | 2026-11-04T19:01:08.297767+00:00 | 100 | 1.325 | 200 | 2 | — | no | pass |
| 70 | 2026-11-04T19:01:11.627340+00:00 | 100 | 1.289 | 200 | 2 | — | no | pass |
| 71 | 2026-11-04T19:01:14.922287+00:00 | 100 | 1.633 | 200 | 2 | — | no | pass |
| 72 | 2026-11-04T19:01:18.560596+00:00 | 100 | 1.271 | 200 | 2 | — | no | pass |
| 73 | 2026-11-04T19:01:21.832756+00:00 | 100 | 1.329 | 200 | 2 | — | no | pass |
| 74 | 2026-11-04T19:01:25.167560+00:00 | 100 | 1.648 | 200 | 2 | — | no | pass |
| 75 | 2026-11-04T19:01:28.820133+00:00 | 100 | 1.561 | 200 | 2 | — | no | pass |
| 76 | 2026-11-04T19:01:32.386271+00:00 | 100 | 1.352 | 200 | 2 | — | no | pass |
| 77 | 2026-11-04T19:01:35.742095+00:00 | 100 | 1.412 | 200 | 2 | — | no | pass |
| 78 | 2026-11-04T19:01:39.159907+00:00 | 100 | 1.471 | 200 | 2 | — | no | pass |
| 79 | 2026-11-04T19:01:42.636148+00:00 | 100 | 1.307 | 200 | 2 | — | no | pass |
| 80 | 2026-11-04T19:01:45.949011+00:00 | 100 | 1.355 | 200 | 2 | — | no | pass |
| 81 | 2026-11-04T19:01:49.309432+00:00 | 100 | 1.345 | 200 | 2 | — | no | pass |
| 82 | 2026-11-04T19:01:52.659386+00:00 | 100 | 1.279 | 200 | 2 | — | no | pass |
| 83 | 2026-11-04T19:01:55.944550+00:00 | 100 | 1.34 | 200 | 2 | — | no | pass |
| 84 | 2026-11-04T19:01:59.289206+00:00 | 100 | 1.496 | 200 | 2 | — | no | pass |
| 85 | 2026-11-04T19:02:02.790982+00:00 | 100 | 1.362 | 200 | 2 | — | no | pass |
| 86 | 2026-11-04T19:02:06.155541+00:00 | 100 | 1.332 | 200 | 2 | — | no | pass |
| 87 | 2026-11-04T19:02:09.492286+00:00 | 100 | 1.426 | 200 | 2 | — | no | pass |
| 88 | 2026-11-04T19:02:12.924421+00:00 | 100 | 1.385 | 200 | 2 | — | no | pass |
| 89 | 2026-11-04T19:02:16.311612+00:00 | 100 | 1.454 | 200 | 2 | — | no | pass |
| 90 | 2026-11-04T19:02:19.771471+00:00 | 100 | 1.335 | 200 | 2 | — | no | pass |
| 91 | 2026-11-04T19:02:23.112469+00:00 | 100 | 1.514 | 200 | 2 | — | no | pass |
| 92 | 2026-11-04T19:02:26.631733+00:00 | 100 | 1.361 | 200 | 2 | — | no | pass |
| 93 | 2026-11-04T19:02:29.995995+00:00 | 100 | 1.394 | 200 | 2 | — | no | pass |
| 94 | 2026-11-04T19:02:33.395858+00:00 | 100 | 1.298 | 200 | 2 | — | no | pass |
| 95 | 2026-11-04T19:02:36.699115+00:00 | 100 | 1.349 | 200 | 2 | — | no | pass |
| 96 | 2026-11-04T19:02:40.050594+00:00 | 100 | 1.38 | 200 | 2 | — | no | pass |
| 97 | 2026-11-04T19:02:43.436827+00:00 | 100 | 1.407 | 200 | 2 | — | no | pass |
| 98 | 2026-11-04T19:02:46.849972+00:00 | 100 | 1.443 | 200 | 2 | — | no | pass |
| 99 | 2026-11-04T19:02:50.298069+00:00 | 100 | 1.573 | 200 | 2 | — | no | pass |
| 100 | 2026-11-04T19:02:53.877089+00:00 | 100 | 1.358 | 200 | 2 | — | no | pass |
| 101 | 2026-11-04T19:02:57.240861+00:00 | 100 | 1.471 | 200 | 2 | — | no | pass |
| 102 | 2026-11-04T19:03:00.719217+00:00 | 100 | 1.371 | 200 | 2 | — | no | pass |
| 103 | 2026-11-04T19:03:04.093048+00:00 | 100 | 1.561 | 200 | 2 | — | no | pass |
| 104 | 2026-11-04T19:03:07.659313+00:00 | 100 | 1.397 | 200 | 2 | — | no | pass |
| 105 | 2026-11-04T19:03:11.060886+00:00 | 100 | 1.481 | 200 | 2 | — | no | pass |
| 106 | 2026-11-04T19:03:14.548240+00:00 | 100 | 1.418 | 200 | 2 | — | no | pass |
| 107 | 2026-11-04T19:03:17.969036+00:00 | 100 | 1.377 | 200 | 2 | — | no | pass |
| 108 | 2026-11-04T19:03:21.349507+00:00 | 100 | 1.473 | 200 | 2 | — | no | pass |
| 109 | 2026-11-04T19:03:24.825506+00:00 | 100 | 1.689 | 200 | 2 | — | no | pass |
| 110 | 2026-11-04T19:03:28.521299+00:00 | 100 | 1.383 | 200 | 2 | — | no | pass |
| 111 | 2026-11-04T19:03:31.905142+00:00 | 100 | 1.698 | 200 | 2 | — | no | pass |
| 112 | 2026-11-04T19:03:35.610198+00:00 | 100 | 1.347 | 200 | 2 | — | no | pass |
| 113 | 2026-11-04T19:03:38.963712+00:00 | 100 | 1.416 | 200 | 2 | — | no | pass |
| 114 | 2026-11-04T19:03:42.385908+00:00 | 100 | 1.4 | 200 | 2 | — | no | pass |
| 115 | 2026-11-04T19:03:45.792947+00:00 | 100 | 1.329 | 200 | 2 | — | no | pass |
| 116 | 2026-11-04T19:03:49.126030+00:00 | 100 | 1.392 | 200 | 2 | — | no | pass |
| 117 | 2026-11-04T19:03:52.520976+00:00 | 100 | 1.338 | 200 | 2 | — | no | pass |
| 118 | 2026-11-04T19:03:55.862611+00:00 | 100 | 1.571 | 200 | 2 | — | no | pass |
| 119 | 2026-11-04T19:03:59.440405+00:00 | 100 | 1.434 | 200 | 2 | — | no | pass |
| 120 | 2026-11-04T19:04:02.879923+00:00 | 100 | 1.413 | 200 | 2 | — | no | pass |
| 121 | 2026-11-04T19:04:06.298718+00:00 | 100 | 1.409 | 200 | 2 | — | no | pass |
| 122 | 2026-11-04T19:04:09.715466+00:00 | 100 | 1.37 | 200 | 2 | — | no | pass |
| 123 | 2026-11-04T19:04:13.089439+00:00 | 100 | 1.467 | 200 | 2 | — | no | pass |
| 124 | 2026-11-04T19:04:16.558213+00:00 | 100 | 1.504 | 200 | 2 | — | no | pass |
| 125 | 2026-11-04T19:04:20.064350+00:00 | 100 | 1.483 | 200 | 2 | — | no | pass |
| 126 | 2026-11-04T19:04:23.550487+00:00 | 100 | 1.341 | 200 | 2 | — | no | pass |
| 127 | 2026-11-04T19:04:26.897766+00:00 | 100 | 1.427 | 200 | 2 | — | no | pass |
| 128 | 2026-11-04T19:04:30.331799+00:00 | 100 | 1.575 | 200 | 2 | — | no | pass |
| 129 | 2026-11-04T19:04:33.911440+00:00 | 100 | 1.414 | 200 | 2 | — | no | pass |
| 130 | 2026-11-04T19:04:37.331153+00:00 | 100 | 1.471 | 200 | 2 | — | no | pass |
| 131 | 2026-11-04T19:04:40.806920+00:00 | 100 | 1.455 | 200 | 2 | — | no | pass |
| 132 | 2026-11-04T19:04:44.268110+00:00 | 100 | 1.481 | 200 | 2 | — | no | pass |
| 133 | 2026-11-04T19:04:47.755186+00:00 | 100 | 1.642 | 200 | 2 | — | no | pass |
| 134 | 2026-11-04T19:04:51.404670+00:00 | 100 | 1.718 | 200 | 2 | — | no | pass |
| 135 | 2026-11-04T19:04:55.125328+00:00 | 100 | 1.515 | 200 | 2 | — | no | pass |
| 136 | 2026-11-04T19:04:58.645713+00:00 | 100 | 1.486 | 200 | 2 | — | no | pass |
| 137 | 2026-11-04T19:05:02.137864+00:00 | 100 | 1.677 | 200 | 2 | — | no | pass |
| 138 | 2026-11-04T19:05:05.821796+00:00 | 100 | 1.543 | 200 | 2 | — | no | pass |
| 139 | 2026-11-04T19:05:09.369902+00:00 | 100 | 1.613 | 200 | 2 | — | no | pass |
| 140 | 2026-11-04T19:05:12.984562+00:00 | 100 | 1.594 | 200 | 2 | — | no | pass |
| 141 | 2026-11-04T19:05:16.583866+00:00 | 100 | 1.611 | 200 | 2 | — | no | pass |
| 142 | 2026-11-04T19:05:20.201307+00:00 | 100 | 1.602 | 200 | 2 | — | no | pass |
| 143 | 2026-11-04T19:05:23.810756+00:00 | 100 | 1.664 | 200 | 2 | — | no | pass |
| 144 | 2026-11-04T19:05:27.476723+00:00 | 100 | 1.623 | 200 | 2 | — | no | pass |
| 145 | 2026-11-04T19:05:31.105694+00:00 | 100 | 1.576 | 200 | 2 | — | no | pass |
| 146 | 2026-11-04T19:05:34.688675+00:00 | 100 | 1.526 | 200 | 2 | — | no | pass |
| 147 | 2026-11-04T19:05:38.220763+00:00 | 100 | 1.659 | 200 | 2 | — | no | pass |
| 148 | 2026-11-04T19:05:41.886088+00:00 | 100 | 1.571 | 200 | 2 | — | no | pass |
| 149 | 2026-11-04T19:05:45.462643+00:00 | 100 | 1.542 | 200 | 2 | — | no | pass |
| 150 | 2026-11-04T19:05:49.007735+00:00 | 100 | 1.523 | 200 | 2 | — | no | pass |
| 151 | 2026-11-04T19:05:52.536811+00:00 | 100 | 1.556 | 200 | 2 | — | no | pass |
| 152 | 2026-11-04T19:05:56.098517+00:00 | 100 | 1.515 | 200 | 2 | — | no | pass |
| 153 | 2026-11-04T19:05:59.620146+00:00 | 100 | 1.595 | 200 | 2 | — | no | pass |
| 154 | 2026-11-04T19:06:03.220884+00:00 | 100 | 1.984 | 200 | 2 | — | no | pass |
| 155 | 2026-11-04T19:06:07.208631+00:00 | 100 | 1.588 | 200 | 2 | — | no | pass |
| 156 | 2026-11-04T19:06:10.800723+00:00 | 100 | 1.488 | 200 | 2 | — | no | pass |
| 157 | 2026-11-04T19:06:14.291781+00:00 | 100 | 1.506 | 200 | 2 | — | no | pass |
| 158 | 2026-11-04T19:06:17.801116+00:00 | 100 | 1.583 | 200 | 2 | — | no | pass |
| 159 | 2026-11-04T19:06:21.390319+00:00 | 100 | 1.462 | 200 | 2 | — | no | pass |
| 160 | 2026-11-04T19:06:24.858455+00:00 | 100 | 1.524 | 200 | 2 | — | no | pass |
| 161 | 2026-11-04T19:06:28.385507+00:00 | 100 | 1.534 | 200 | 2 | — | no | pass |
| 162 | 2026-11-04T19:06:31.922201+00:00 | 100 | 1.652 | 200 | 2 | — | no | pass |
| 163 | 2026-11-04T19:06:35.580107+00:00 | 100 | 1.519 | 200 | 2 | — | no | pass |
| 164 | 2026-11-04T19:06:39.103415+00:00 | 100 | 1.589 | 200 | 2 | — | no | pass |
| 165 | 2026-11-04T19:06:42.698217+00:00 | 100 | 1.558 | 200 | 2 | — | no | pass |
| 166 | 2026-11-04T19:06:46.258642+00:00 | 100 | 1.863 | 200 | 2 | — | no | pass |
| 167 | 2026-11-04T19:06:50.126785+00:00 | 100 | 1.814 | 200 | 2 | — | no | pass |
| 168 | 2026-11-04T19:06:53.946689+00:00 | 100 | 1.698 | 200 | 2 | — | no | pass |
| 169 | 2026-11-04T19:06:57.652216+00:00 | 100 | 1.765 | 200 | 2 | — | no | pass |
| 170 | 2026-11-04T19:07:01.421698+00:00 | 100 | 1.583 | 200 | 2 | — | no | pass |
| 171 | 2026-11-04T19:07:05.010067+00:00 | 100 | 1.649 | 200 | 2 | — | no | pass |
| 172 | 2026-11-04T19:07:08.666913+00:00 | 100 | 1.499 | 200 | 2 | — | no | pass |
| 173 | 2026-11-04T19:07:12.171667+00:00 | 100 | 1.564 | 200 | 2 | — | no | pass |
| 174 | 2026-11-04T19:07:15.740532+00:00 | 100 | 1.619 | 200 | 2 | — | no | pass |
| 175 | 2026-11-04T19:07:19.360925+00:00 | 100 | 1.617 | 200 | 2 | — | no | pass |
| 176 | 2026-11-04T19:07:22.984618+00:00 | 100 | 1.716 | 200 | 2 | — | no | pass |
| 177 | 2026-11-04T19:07:26.706741+00:00 | 100 | 1.607 | 200 | 2 | — | no | pass |
| 178 | 2026-11-04T19:07:30.320321+00:00 | 100 | 1.591 | 200 | 2 | — | no | pass |
| 179 | 2026-11-04T19:07:33.917185+00:00 | 100 | 1.547 | 200 | 2 | — | no | pass |
| 180 | 2026-11-04T19:07:37.470220+00:00 | 100 | 1.546 | 200 | 2 | — | no | pass |
| 181 | 2026-11-04T19:07:41.018705+00:00 | 100 | 1.618 | 200 | 2 | — | no | pass |
| 182 | 2026-11-04T19:07:44.641763+00:00 | 100 | 1.685 | 200 | 2 | — | no | pass |
| 183 | 2026-11-04T19:07:48.332837+00:00 | 100 | 1.528 | 200 | 2 | — | no | pass |
| 184 | 2026-11-04T19:07:51.867796+00:00 | 100 | 1.503 | 200 | 2 | — | no | pass |
| 185 | 2026-11-04T19:07:55.377844+00:00 | 100 | 1.589 | 200 | 2 | — | no | pass |
| 186 | 2026-11-04T19:07:58.970176+00:00 | 100 | 1.529 | 200 | 2 | — | no | pass |
| 187 | 2026-11-04T19:08:02.501506+00:00 | 100 | 1.776 | 200 | 2 | — | no | pass |
| 188 | 2026-11-04T19:08:06.283405+00:00 | 100 | 1.649 | 200 | 2 | — | no | pass |
| 189 | 2026-11-04T19:08:09.939033+00:00 | 100 | 1.751 | 200 | 2 | — | no | pass |
| 190 | 2026-11-04T19:08:13.697470+00:00 | 100 | 1.716 | 200 | 2 | — | no | pass |
| 191 | 2026-11-04T19:08:17.418043+00:00 | 100 | 1.636 | 200 | 2 | — | no | pass |
| 192 | 2026-11-04T19:08:21.060076+00:00 | 100 | 1.54 | 200 | 2 | — | no | pass |
| 193 | 2026-11-04T19:08:24.605455+00:00 | 100 | 1.698 | 200 | 2 | — | no | pass |
| 194 | 2026-11-04T19:08:28.310331+00:00 | 100 | 1.604 | 200 | 2 | — | no | pass |
| 195 | 2026-11-04T19:08:31.917224+00:00 | 100 | 1.675 | 200 | 2 | — | no | pass |
| 196 | 2026-11-04T19:08:35.599154+00:00 | 100 | 1.708 | 200 | 2 | — | no | pass |
| 197 | 2026-11-04T19:08:39.312709+00:00 | 100 | 1.716 | 200 | 2 | — | no | pass |
| 198 | 2026-11-04T19:08:43.033471+00:00 | 100 | 1.567 | 200 | 2 | — | no | pass |
| 199 | 2026-11-04T19:08:46.605150+00:00 | 100 | 1.521 | 200 | 2 | — | no | pass |
| 200 | 2026-11-04T19:08:50.129799+00:00 | 100 | 1.607 | 200 | 2 | — | no | pass |

### udn batch 2

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:08:57.388171+00:00 | 50 | 0.761 | 418 | 2 | — | no | pass |
| 2 | 2026-11-04T19:09:02.122986+00:00 | 50 | 0.837 | 418 | 2 | — | no | pass |
| 3 | 2026-11-04T19:09:06.985654+00:00 | 50 | 0.783 | 418 | 2 | — | no | pass |
| 4 | 2026-11-04T19:09:11.838113+00:00 | 50 | 0.77 | 418 | 2 | — | no | pass |
| 5 | 2026-11-04T19:09:16.618944+00:00 | 50 | 0.833 | 418 | 2 | — | no | pass |
| 6 | 2026-11-04T19:09:21.460812+00:00 | 50 | 0.919 | 418 | 2 | — | no | pass |
| 7 | 2026-11-04T19:13:09.480357+00:00 | 50 | 0.824 | 418 | 2 | — | no | pass |
| 8 | 2026-11-04T19:13:12.311992+00:00 | 50 | 0.548 | 200 | 2 | — | no | pass |
| 9 | 2026-11-04T19:13:14.866316+00:00 | 50 | 0.541 | 200 | 2 | — | no | pass |
| 10 | 2026-11-04T19:13:17.410770+00:00 | 50 | 0.56 | 200 | 2 | — | no | pass |
| 11 | 2026-11-04T19:13:19.977559+00:00 | 50 | 0.561 | 200 | 2 | — | no | pass |
| 12 | 2026-11-04T19:13:22.545384+00:00 | 50 | 0.563 | 200 | 2 | — | no | pass |
| 13 | 2026-11-04T19:13:25.114736+00:00 | 50 | 0.589 | 200 | 2 | — | no | pass |
| 14 | 2026-11-04T19:13:27.711066+00:00 | 50 | 0.577 | 200 | 2 | — | no | pass |
| 15 | 2026-11-04T19:13:30.294245+00:00 | 50 | 0.573 | 200 | 2 | — | no | pass |
| 16 | 2026-11-04T19:13:32.874927+00:00 | 50 | 0.579 | 200 | 2 | — | no | pass |
| 17 | 2026-11-04T19:13:35.462292+00:00 | 50 | 0.573 | 200 | 2 | — | no | pass |
| 18 | 2026-11-04T19:13:38.041342+00:00 | 50 | 0.553 | 200 | 2 | — | no | pass |
| 19 | 2026-11-04T19:13:40.602289+00:00 | 50 | 0.589 | 200 | 2 | — | no | pass |
| 20 | 2026-11-04T19:13:43.197648+00:00 | 50 | 0.582 | 200 | 2 | — | no | pass |

### udn batch 3

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:13:47.889817+00:00 | 50 | 0.761 | 418 | 2 | — | no | pass |
| 2 | 2026-11-04T19:13:50.658235+00:00 | 50 | 0.554 | 200 | 2 | — | no | pass |
| 3 | 2026-11-04T19:13:53.217650+00:00 | 50 | 0.552 | 200 | 2 | — | no | pass |
| 4 | 2026-11-04T19:13:55.776929+00:00 | 50 | 0.538 | 200 | 2 | — | no | pass |
| 5 | 2026-11-04T19:13:58.321185+00:00 | 50 | 0.722 | 200 | 2 | — | no | pass |
| 6 | 2026-11-04T19:14:01.051761+00:00 | 50 | 0.553 | 200 | 2 | — | no | pass |
| 7 | 2026-11-04T19:14:03.612343+00:00 | 50 | 0.595 | 200 | 2 | — | no | pass |
| 8 | 2026-11-04T19:14:06.215102+00:00 | 50 | 0.537 | 200 | 2 | — | no | pass |
| 9 | 2026-11-04T19:14:08.753770+00:00 | 50 | 0.546 | 200 | 2 | — | no | pass |
| 10 | 2026-11-04T19:14:11.303952+00:00 | 50 | 0.555 | 200 | 2 | — | no | pass |
| 11 | 2026-11-04T19:14:13.863551+00:00 | 50 | 0.555 | 200 | 2 | — | no | pass |
| 12 | 2026-11-04T19:14:16.426147+00:00 | 50 | 0.561 | 200 | 2 | — | no | pass |
| 13 | 2026-11-04T19:14:18.993844+00:00 | 50 | 0.542 | 200 | 2 | — | no | pass |
| 14 | 2026-11-04T19:14:21.543027+00:00 | 50 | 0.649 | 200 | 2 | — | no | pass |
| 15 | 2026-11-04T19:14:24.197821+00:00 | 50 | 0.588 | 200 | 2 | — | no | pass |
| 16 | 2026-11-04T19:14:26.790953+00:00 | 50 | 0.585 | 200 | 2 | — | no | pass |
| 17 | 2026-11-04T19:14:29.383440+00:00 | 50 | 0.613 | 200 | 2 | — | no | pass |
| 18 | 2026-11-04T19:14:32.002895+00:00 | 50 | 0.562 | 200 | 2 | — | no | pass |
| 19 | 2026-11-04T19:14:34.571711+00:00 | 50 | 0.557 | 200 | 2 | — | no | pass |
| 20 | 2026-11-04T19:14:37.132410+00:00 | 50 | 0.602 | 200 | 2 | — | no | pass |

### udn batch 4

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:14:41.874401+00:00 | 50 | 0.859 | 418 | 2 | — | no | pass |
| 2 | 2026-11-04T19:14:44.736433+00:00 | 50 | 0.628 | 200 | 2 | — | no | pass |
| 3 | 2026-11-04T19:14:47.368749+00:00 | 50 | 0.62 | 200 | 2 | — | no | pass |
| 4 | 2026-11-04T19:14:49.994790+00:00 | 50 | 0.638 | 200 | 2 | — | no | pass |
| 5 | 2026-11-04T19:14:52.637053+00:00 | 50 | 0.641 | 200 | 2 | — | no | pass |
| 6 | 2026-11-04T19:14:55.282660+00:00 | 50 | 0.608 | 200 | 2 | — | no | pass |
| 7 | 2026-11-04T19:14:57.898255+00:00 | 50 | 0.659 | 200 | 2 | — | no | pass |
| 8 | 2026-11-04T19:15:00.562141+00:00 | 50 | 0.638 | 200 | 2 | — | no | pass |
| 9 | 2026-11-04T19:15:03.205294+00:00 | 50 | 0.714 | 200 | 2 | — | no | pass |
| 10 | 2026-11-04T19:15:05.925677+00:00 | 50 | 0.693 | 200 | 2 | — | no | pass |
| 11 | 2026-11-04T19:15:08.626416+00:00 | 50 | 0.612 | 200 | 2 | — | no | pass |
| 12 | 2026-11-04T19:15:11.245291+00:00 | 50 | 0.632 | 200 | 2 | — | no | pass |
| 13 | 2026-11-04T19:15:13.884808+00:00 | 50 | 0.613 | 200 | 2 | — | no | pass |
| 14 | 2026-11-04T19:15:16.504761+00:00 | 50 | 0.719 | 200 | 2 | — | no | pass |
| 15 | 2026-11-04T19:15:19.227313+00:00 | 50 | 0.623 | 200 | 2 | — | no | pass |
| 16 | 2026-11-04T19:15:21.856983+00:00 | 50 | 0.652 | 200 | 2 | — | no | pass |
| 17 | 2026-11-04T19:15:24.512134+00:00 | 50 | 0.71 | 200 | 2 | — | no | pass |
| 18 | 2026-11-04T19:15:27.227928+00:00 | 50 | 0.66 | 200 | 2 | — | no | pass |
| 19 | 2026-11-04T19:15:29.893972+00:00 | 50 | 0.697 | 200 | 2 | — | no | pass |
| 20 | 2026-11-04T19:15:32.599106+00:00 | 50 | 0.68 | 200 | 2 | — | no | pass |

### newspapers volume observations

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:13:10.081123+00:00 | 2 | 0.661 | — | 1 | 613283 | no | pass |
| 2 | 2026-11-04T19:13:13.245530+00:00 | 2 | 1.159 | — | 1 | 613283 | no | pass |
| 3 | 2026-11-04T19:13:15.840753+00:00 | 2 | 0.589 | — | 1 | 613283 | no | pass |
| 4 | 2026-11-04T19:13:18.450540+00:00 | 2 | 0.606 | — | 1 | 613285 | no | pass |
| 5 | 2026-11-04T19:13:21.096820+00:00 | 2 | 0.64 | — | 1 | 613283 | no | pass |
| 6 | 2026-11-04T19:13:23.752517+00:00 | 2 | 0.651 | — | 1 | 613284 | no | pass |
| 7 | 2026-11-04T19:13:26.389580+00:00 | 2 | 0.631 | — | 1 | 613282 | no | pass |
| 8 | 2026-11-04T19:13:29.093430+00:00 | 2 | 0.699 | — | 1 | 613282 | no | pass |
| 9 | 2026-11-04T19:13:31.810476+00:00 | 2 | 0.711 | — | 1 | 613282 | no | pass |
| 10 | 2026-11-04T19:13:34.419257+00:00 | 2 | 0.604 | — | 1 | 613283 | no | pass |
| 11 | 2026-11-04T19:13:37.010356+00:00 | 2 | 0.585 | — | 1 | 613283 | no | pass |
| 12 | 2026-11-04T19:13:39.622755+00:00 | 2 | 0.606 | — | 1 | 613284 | no | pass |
| 13 | 2026-11-04T19:13:42.216513+00:00 | 2 | 0.587 | — | 1 | 613284 | no | pass |
| 14 | 2026-11-04T19:13:44.810158+00:00 | 2 | 0.591 | — | 1 | 613285 | no | pass |
| 15 | 2026-11-04T19:13:47.475003+00:00 | 2 | 0.659 | — | 1 | 613282 | no | pass |
| 16 | 2026-11-04T19:13:50.064213+00:00 | 2 | 0.587 | — | 1 | 613283 | no | pass |
| 17 | 2026-11-04T19:13:52.667633+00:00 | 2 | 0.598 | — | 1 | 613285 | no | pass |
| 18 | 2026-11-04T19:13:55.348509+00:00 | 2 | 0.674 | — | 1 | 613284 | no | pass |
| 19 | 2026-11-04T19:13:57.953885+00:00 | 2 | 0.602 | — | 1 | 613285 | no | pass |
| 20 | 2026-11-04T19:14:00.637175+00:00 | 2 | 0.679 | — | 1 | 613282 | no | pass |
| 21 | 2026-11-04T19:14:03.312873+00:00 | 2 | 0.673 | — | 1 | 613282 | no | pass |
| 22 | 2026-11-04T19:14:05.910148+00:00 | 2 | 0.595 | — | 1 | 613283 | no | pass |
| 23 | 2026-11-04T19:14:08.601675+00:00 | 2 | 0.688 | — | 1 | 613282 | no | pass |
| 24 | 2026-11-04T19:14:11.189152+00:00 | 2 | 0.583 | — | 1 | 613285 | no | pass |
| 25 | 2026-11-04T19:14:13.881506+00:00 | 2 | 0.687 | — | 1 | 613282 | no | pass |
| 26 | 2026-11-04T19:14:16.552269+00:00 | 2 | 0.664 | — | 1 | 613283 | no | pass |
| 27 | 2026-11-04T19:14:19.200344+00:00 | 2 | 0.643 | — | 1 | 613284 | no | pass |
| 28 | 2026-11-04T19:14:21.821512+00:00 | 2 | 0.615 | — | 1 | 613285 | no | pass |
| 29 | 2026-11-04T19:14:24.452472+00:00 | 2 | 0.625 | — | 1 | 613285 | no | pass |
| 30 | 2026-11-04T19:14:27.047718+00:00 | 2 | 0.591 | — | 1 | 613282 | no | pass |
| 31 | 2026-11-04T19:14:29.642775+00:00 | 2 | 0.589 | — | 1 | 613283 | no | pass |
| 32 | 2026-11-04T19:14:32.255736+00:00 | 2 | 0.61 | — | 1 | 613285 | no | pass |
| 33 | 2026-11-04T19:14:34.852526+00:00 | 2 | 0.591 | — | 1 | 613282 | no | pass |
| 34 | 2026-11-04T19:14:37.505790+00:00 | 2 | 0.648 | — | 1 | 613285 | no | pass |
| 35 | 2026-11-04T19:14:40.095864+00:00 | 2 | 0.579 | — | 1 | 613283 | no | pass |
| 36 | 2026-11-04T19:14:42.703411+00:00 | 2 | 0.601 | — | 1 | 613285 | no | pass |
| 37 | 2026-11-04T19:14:45.326388+00:00 | 2 | 0.619 | — | 1 | 613283 | no | pass |
| 38 | 2026-11-04T19:14:47.945233+00:00 | 2 | 0.612 | — | 1 | 613283 | no | pass |
| 39 | 2026-11-04T19:14:50.557921+00:00 | 2 | 0.607 | — | 1 | 613283 | no | pass |
| 40 | 2026-11-04T19:14:53.157403+00:00 | 2 | 0.594 | — | 1 | 613282 | no | pass |
| 41 | 2026-11-04T19:14:55.791703+00:00 | 2 | 0.628 | — | 1 | 613284 | no | pass |
| 42 | 2026-11-04T19:14:58.472861+00:00 | 2 | 0.677 | — | 1 | 613284 | no | pass |
| 43 | 2026-11-04T19:15:01.092624+00:00 | 2 | 0.615 | — | 1 | 613283 | no | pass |
| 44 | 2026-11-04T19:15:03.745451+00:00 | 2 | 0.646 | — | 1 | 613282 | no | pass |
| 45 | 2026-11-04T19:15:06.378398+00:00 | 2 | 0.63 | — | 1 | 613284 | no | pass |
| 46 | 2026-11-04T19:15:09.028463+00:00 | 2 | 0.646 | — | 1 | 613283 | no | pass |
| 47 | 2026-11-04T19:15:11.652149+00:00 | 2 | 0.62 | — | 1 | 613282 | no | pass |
| 48 | 2026-11-04T19:15:14.319318+00:00 | 2 | 0.663 | — | 1 | 613282 | no | pass |
| 49 | 2026-11-04T19:15:16.964820+00:00 | 2 | 0.641 | — | 1 | 613283 | no | pass |
| 50 | 2026-11-04T19:15:19.577271+00:00 | 2 | 0.606 | — | 1 | 613283 | no | pass |
| 51 | 2026-11-04T19:15:22.263247+00:00 | 2 | 0.679 | — | 1 | 613282 | no | pass |
| 52 | 2026-11-04T19:15:24.999343+00:00 | 2 | 0.734 | — | 1 | 613282 | no | pass |
| 53 | 2026-11-04T19:15:27.629313+00:00 | 2 | 0.627 | — | 1 | 613282 | no | pass |
| 54 | 2026-11-04T19:15:30.656269+00:00 | 2 | 1.02 | — | 1 | 613283 | no | pass |
| 55 | 2026-11-04T19:15:33.320220+00:00 | 2 | 0.662 | — | 1 | 613282 | no | pass |
| 56 | 2026-11-04T19:15:35.901472+00:00 | 2 | 0.578 | — | 1 | 613284 | no | pass |
| 57 | 2026-11-04T19:15:38.514430+00:00 | 2 | 0.61 | — | 1 | 613285 | no | pass |
| 58 | 2026-11-04T19:15:41.157094+00:00 | 2 | 0.637 | — | 1 | 613283 | no | pass |
| 59 | 2026-11-04T19:15:43.807557+00:00 | 2 | 0.644 | — | 1 | 613283 | no | pass |
| 60 | 2026-11-04T19:15:46.570858+00:00 | 2 | 0.757 | — | 1 | 613282 | no | pass |
| 61 | 2026-11-04T19:15:49.219653+00:00 | 2 | 0.646 | — | 1 | 613284 | no | pass |
| 62 | 2026-11-04T19:15:51.821294+00:00 | 2 | 0.598 | — | 1 | 613284 | no | pass |
| 63 | 2026-11-04T19:15:54.470056+00:00 | 2 | 0.643 | — | 1 | 613283 | no | pass |
| 64 | 2026-11-04T19:15:57.110282+00:00 | 2 | 0.637 | — | 1 | 613283 | no | pass |
| 65 | 2026-11-04T19:15:59.785281+00:00 | 2 | 0.674 | — | 1 | 613283 | no | pass |
| 66 | 2026-11-04T19:16:02.447608+00:00 | 2 | 0.659 | — | 1 | 613284 | no | pass |
| 67 | 2026-11-04T19:16:05.066574+00:00 | 2 | 0.613 | — | 1 | 613285 | no | pass |
| 68 | 2026-11-04T19:16:07.703347+00:00 | 2 | 0.633 | — | 1 | 613285 | no | pass |
| 69 | 2026-11-04T19:16:10.380285+00:00 | 2 | 0.672 | — | 1 | 613283 | no | pass |
| 70 | 2026-11-04T19:16:12.984403+00:00 | 2 | 0.6 | — | 1 | 613283 | no | pass |
| 71 | 2026-11-04T19:16:15.567934+00:00 | 2 | 0.582 | — | 1 | 613284 | no | pass |
| 72 | 2026-11-04T19:16:18.280702+00:00 | 2 | 0.707 | — | 1 | 613284 | no | pass |
| 73 | 2026-11-04T19:16:20.920999+00:00 | 2 | 0.634 | — | 1 | 613283 | no | pass |
| 74 | 2026-11-04T19:16:23.658754+00:00 | 2 | 0.731 | — | 1 | 613283 | no | pass |
| 75 | 2026-11-04T19:16:26.309164+00:00 | 2 | 0.645 | — | 1 | 613282 | no | pass |
| 76 | 2026-11-04T19:16:28.904903+00:00 | 2 | 0.59 | — | 1 | 613282 | no | pass |
| 77 | 2026-11-04T19:16:31.609581+00:00 | 2 | 0.7 | — | 1 | 613282 | no | pass |
| 78 | 2026-11-04T19:16:34.205803+00:00 | 2 | 0.588 | — | 1 | 613283 | no | pass |
| 79 | 2026-11-04T19:16:37.018857+00:00 | 2 | 0.808 | — | 1 | 613282 | no | pass |
| 80 | 2026-11-04T19:16:39.648217+00:00 | 2 | 0.623 | — | 1 | 613283 | no | pass |
| 81 | 2026-11-04T19:16:42.262970+00:00 | 2 | 0.609 | — | 1 | 613282 | no | pass |
| 82 | 2026-11-04T19:16:44.900257+00:00 | 2 | 0.631 | — | 1 | 613283 | no | pass |
| 83 | 2026-11-04T19:16:47.517869+00:00 | 2 | 0.611 | — | 1 | 613284 | no | pass |
| 84 | 2026-11-04T19:16:50.157895+00:00 | 2 | 0.637 | — | 1 | 613285 | no | pass |
| 85 | 2026-11-04T19:16:52.836793+00:00 | 2 | 0.673 | — | 1 | 613283 | no | pass |
| 86 | 2026-11-04T19:16:55.463919+00:00 | 2 | 0.624 | — | 1 | 613282 | no | pass |
| 87 | 2026-11-04T19:16:58.078211+00:00 | 2 | 0.609 | — | 1 | 613283 | no | pass |
| 88 | 2026-11-04T19:17:00.706404+00:00 | 2 | 0.625 | — | 1 | 613283 | no | pass |
| 89 | 2026-11-04T19:17:03.407833+00:00 | 2 | 0.695 | — | 1 | 613283 | no | pass |
| 90 | 2026-11-04T19:17:06.033381+00:00 | 2 | 0.62 | — | 1 | 613284 | no | pass |
| 91 | 2026-11-04T19:17:08.641645+00:00 | 2 | 0.602 | — | 1 | 613284 | no | pass |
| 92 | 2026-11-04T19:17:11.253568+00:00 | 2 | 0.607 | — | 1 | 613283 | no | pass |
| 93 | 2026-11-04T19:17:13.873881+00:00 | 2 | 0.614 | — | 1 | 613282 | no | pass |
| 94 | 2026-11-04T19:17:16.528241+00:00 | 2 | 0.648 | — | 1 | 613285 | no | pass |
| 95 | 2026-11-04T19:17:19.231220+00:00 | 2 | 0.7 | — | 1 | 613283 | no | pass |
| 96 | 2026-11-04T19:17:21.870379+00:00 | 2 | 0.632 | — | 1 | 613282 | no | pass |
| 97 | 2026-11-04T19:17:24.630021+00:00 | 2 | 0.754 | — | 1 | 613284 | no | pass |
| 98 | 2026-11-04T19:17:27.235325+00:00 | 2 | 0.599 | — | 1 | 613283 | no | pass |
| 99 | 2026-11-04T19:17:29.896442+00:00 | 2 | 0.655 | — | 1 | 613282 | no | pass |
| 100 | 2026-11-04T19:17:32.586702+00:00 | 2 | 0.684 | — | 1 | 613282 | no | pass |
| 101 | 2026-11-04T19:17:35.417847+00:00 | 2 | 0.825 | — | 1 | 613282 | no | pass |
| 102 | 2026-11-04T19:17:38.043276+00:00 | 2 | 0.62 | — | 1 | 613282 | no | pass |
| 103 | 2026-11-04T19:17:40.652565+00:00 | 2 | 0.607 | — | 1 | 613282 | no | pass |
| 104 | 2026-11-04T19:17:43.452747+00:00 | 2 | 0.795 | — | 1 | 613282 | no | pass |
| 105 | 2026-11-04T19:17:46.075134+00:00 | 2 | 0.617 | — | 1 | 613284 | no | pass |
| 106 | 2026-11-04T19:17:48.820373+00:00 | 2 | 0.739 | — | 1 | 613284 | no | pass |
| 107 | 2026-11-04T19:17:51.410664+00:00 | 2 | 0.584 | — | 1 | 613285 | no | pass |
| 108 | 2026-11-04T19:17:53.999921+00:00 | 2 | 0.588 | — | 1 | 613284 | no | pass |
| 109 | 2026-11-04T19:17:56.612428+00:00 | 2 | 0.611 | — | 1 | 613283 | no | pass |
| 110 | 2026-11-04T19:17:59.342280+00:00 | 2 | 0.727 | — | 1 | 613283 | no | pass |
| 111 | 2026-11-04T19:18:01.956335+00:00 | 2 | 0.608 | — | 1 | 613284 | no | pass |
| 112 | 2026-11-04T19:18:04.668171+00:00 | 2 | 0.705 | — | 1 | 613283 | no | pass |
| 113 | 2026-11-04T19:18:07.390167+00:00 | 2 | 0.719 | — | 1 | 613282 | no | pass |
| 114 | 2026-11-04T19:18:10.038892+00:00 | 2 | 0.646 | — | 1 | 613282 | no | pass |
| 115 | 2026-11-04T19:18:12.882996+00:00 | 2 | 0.838 | — | 1 | 613285 | no | pass |
| 116 | 2026-11-04T19:18:15.576919+00:00 | 2 | 0.687 | — | 1 | 613283 | no | pass |
| 117 | 2026-11-04T19:18:18.182190+00:00 | 2 | 0.599 | — | 1 | 613283 | no | pass |
| 118 | 2026-11-04T19:18:20.853043+00:00 | 2 | 0.664 | — | 1 | 613282 | no | pass |
| 119 | 2026-11-04T19:18:23.484373+00:00 | 2 | 0.628 | — | 1 | 613282 | no | pass |
| 120 | 2026-11-04T19:18:26.072442+00:00 | 2 | 0.581 | — | 1 | 613285 | no | pass |
| 121 | 2026-11-04T19:18:28.788353+00:00 | 2 | 0.709 | — | 1 | 613282 | no | pass |
| 122 | 2026-11-04T19:18:31.420156+00:00 | 2 | 0.626 | — | 1 | 613285 | no | pass |
| 123 | 2026-11-04T19:18:34.120097+00:00 | 2 | 0.694 | — | 1 | 613284 | no | pass |
| 124 | 2026-11-04T19:18:36.804745+00:00 | 2 | 0.678 | — | 1 | 613283 | no | pass |
| 125 | 2026-11-04T19:18:39.722472+00:00 | 2 | 0.911 | — | 1 | 613282 | no | pass |
| 126 | 2026-11-04T19:18:42.357471+00:00 | 2 | 0.629 | — | 1 | 613283 | no | pass |
| 127 | 2026-11-04T19:18:45.091738+00:00 | 2 | 0.73 | — | 1 | 613282 | no | pass |
| 128 | 2026-11-04T19:18:47.751171+00:00 | 2 | 0.653 | — | 1 | 613282 | no | pass |
| 129 | 2026-11-04T19:18:50.363724+00:00 | 2 | 0.61 | — | 1 | 613285 | no | pass |
| 130 | 2026-11-04T19:18:52.961562+00:00 | 2 | 0.592 | — | 1 | 613285 | no | pass |
| 131 | 2026-11-04T19:18:55.654940+00:00 | 2 | 0.69 | — | 1 | 613283 | no | pass |
| 132 | 2026-11-04T19:18:58.310976+00:00 | 2 | 0.651 | — | 1 | 613285 | no | pass |
| 133 | 2026-11-04T19:19:00.989947+00:00 | 2 | 0.672 | — | 1 | 613283 | no | pass |
| 134 | 2026-11-04T19:19:03.674420+00:00 | 2 | 0.678 | — | 1 | 613282 | no | pass |
| 135 | 2026-11-04T19:19:06.291199+00:00 | 2 | 0.61 | — | 1 | 613283 | no | pass |
| 136 | 2026-11-04T19:19:08.876836+00:00 | 2 | 0.579 | — | 1 | 613285 | no | pass |
| 137 | 2026-11-04T19:19:11.469767+00:00 | 2 | 0.591 | — | 1 | 613285 | no | pass |
| 138 | 2026-11-04T19:19:14.082618+00:00 | 2 | 0.608 | — | 1 | 613285 | no | pass |
| 139 | 2026-11-04T19:19:16.773425+00:00 | 2 | 0.687 | — | 1 | 613285 | no | pass |
| 140 | 2026-11-04T19:19:19.379015+00:00 | 2 | 0.602 | — | 1 | 613282 | no | pass |
| 141 | 2026-11-04T19:19:22.008198+00:00 | 2 | 0.623 | — | 1 | 613283 | no | pass |
| 142 | 2026-11-04T19:19:24.661545+00:00 | 2 | 0.647 | — | 1 | 613282 | no | pass |
| 143 | 2026-11-04T19:19:27.388717+00:00 | 2 | 0.722 | — | 1 | 613282 | no | pass |
| 144 | 2026-11-04T19:19:30.004191+00:00 | 2 | 0.609 | — | 1 | 613283 | no | pass |
| 145 | 2026-11-04T19:19:32.640206+00:00 | 2 | 0.63 | — | 1 | 613284 | no | pass |
| 146 | 2026-11-04T19:19:35.479677+00:00 | 2 | 0.838 | — | 1 | 613282 | no | pass |
| 147 | 2026-11-04T19:19:38.095522+00:00 | 2 | 0.611 | — | 1 | 613282 | no | pass |
| 148 | 2026-11-04T19:19:40.665091+00:00 | 2 | 0.563 | — | 1 | 613284 | no | pass |
| 149 | 2026-11-04T19:19:43.432372+00:00 | 2 | 0.764 | — | 1 | 613284 | no | pass |
| 150 | 2026-11-04T19:19:46.091449+00:00 | 2 | 0.656 | — | 1 | 613283 | no | pass |
| 151 | 2026-11-04T19:19:48.723344+00:00 | 2 | 0.627 | — | 1 | 613283 | no | pass |
| 152 | 2026-11-04T19:19:51.452532+00:00 | 2 | 0.723 | — | 1 | 613283 | no | pass |
| 153 | 2026-11-04T19:19:54.022348+00:00 | 2 | 0.563 | — | 1 | 613283 | no | pass |
| 154 | 2026-11-04T19:19:56.635431+00:00 | 2 | 0.61 | — | 1 | 613283 | no | pass |
| 155 | 2026-11-04T19:19:59.275822+00:00 | 2 | 0.635 | — | 1 | 613284 | no | pass |
| 156 | 2026-11-04T19:20:02.011153+00:00 | 2 | 0.733 | — | 1 | 613282 | no | pass |
| 157 | 2026-11-04T19:20:04.633540+00:00 | 2 | 0.616 | — | 1 | 613283 | no | pass |
| 158 | 2026-11-04T19:20:07.241830+00:00 | 2 | 0.605 | — | 1 | 613282 | no | pass |
| 159 | 2026-11-04T19:20:09.879273+00:00 | 2 | 0.631 | — | 1 | 613282 | no | pass |
| 160 | 2026-11-04T19:20:12.566591+00:00 | 2 | 0.685 | — | 1 | 613284 | no | pass |
| 161 | 2026-11-04T19:20:15.189915+00:00 | 2 | 0.618 | — | 1 | 613285 | no | pass |
| 162 | 2026-11-04T19:20:18.185025+00:00 | 2 | 0.988 | — | 1 | 613283 | no | pass |
| 163 | 2026-11-04T19:20:21.299896+00:00 | 2 | 1.112 | — | 1 | 613282 | no | pass |
| 164 | 2026-11-04T19:20:24.025371+00:00 | 2 | 0.719 | — | 1 | 613285 | no | pass |
| 165 | 2026-11-04T19:20:26.711708+00:00 | 2 | 0.681 | — | 1 | 613283 | no | pass |
| 166 | 2026-11-04T19:20:29.309931+00:00 | 2 | 0.594 | — | 1 | 613283 | no | pass |
| 167 | 2026-11-04T19:20:31.914635+00:00 | 2 | 0.598 | — | 1 | 613282 | no | pass |
| 168 | 2026-11-04T19:20:34.668205+00:00 | 2 | 0.749 | — | 1 | 613283 | no | pass |
| 169 | 2026-11-04T19:20:37.334688+00:00 | 2 | 0.663 | — | 1 | 613283 | no | pass |
| 170 | 2026-11-04T19:20:39.966591+00:00 | 2 | 0.628 | — | 1 | 613285 | no | pass |
| 171 | 2026-11-04T19:20:42.568093+00:00 | 2 | 0.595 | — | 1 | 613283 | no | pass |
| 172 | 2026-11-04T19:20:45.369598+00:00 | 2 | 0.799 | — | 1 | 613282 | no | pass |
| 173 | 2026-11-04T19:20:47.992229+00:00 | 2 | 0.616 | — | 1 | 613285 | no | pass |
| 174 | 2026-11-04T19:20:50.615165+00:00 | 2 | 0.621 | — | 1 | 613284 | no | pass |
| 175 | 2026-11-04T19:20:53.279473+00:00 | 2 | 0.661 | — | 1 | 613284 | no | pass |
| 176 | 2026-11-04T19:20:55.872843+00:00 | 2 | 0.586 | — | 1 | 613282 | no | pass |
| 177 | 2026-11-04T19:20:58.506561+00:00 | 2 | 0.629 | — | 1 | 613283 | no | pass |
| 178 | 2026-11-04T19:21:01.155256+00:00 | 2 | 0.644 | — | 1 | 613283 | no | pass |
| 179 | 2026-11-04T19:21:03.954472+00:00 | 2 | 0.792 | — | 1 | 613283 | no | pass |
| 180 | 2026-11-04T19:21:06.723565+00:00 | 2 | 0.763 | — | 1 | 613282 | no | pass |
| 181 | 2026-11-04T19:21:09.369032+00:00 | 2 | 0.638 | — | 1 | 613283 | no | pass |
| 182 | 2026-11-04T19:21:12.087514+00:00 | 2 | 0.712 | — | 1 | 613282 | no | pass |
| 183 | 2026-11-04T19:21:14.824419+00:00 | 2 | 0.73 | — | 1 | 613284 | no | pass |
| 184 | 2026-11-04T19:21:17.461733+00:00 | 2 | 0.63 | — | 1 | 613283 | no | pass |
| 185 | 2026-11-04T19:21:20.060742+00:00 | 2 | 0.594 | — | 1 | 613283 | no | pass |
| 186 | 2026-11-04T19:21:22.651009+00:00 | 2 | 0.587 | — | 1 | 613285 | no | pass |
| 187 | 2026-11-04T19:21:25.369439+00:00 | 2 | 0.711 | — | 1 | 613282 | no | pass |
| 188 | 2026-11-04T19:21:28.039588+00:00 | 2 | 0.668 | — | 1 | 613285 | no | pass |
| 189 | 2026-11-04T19:21:30.712738+00:00 | 2 | 0.669 | — | 1 | 613283 | no | pass |
| 190 | 2026-11-04T19:21:33.447535+00:00 | 2 | 0.73 | — | 1 | 613285 | no | pass |
| 191 | 2026-11-04T19:21:36.098520+00:00 | 2 | 0.649 | — | 1 | 613283 | no | pass |
| 192 | 2026-11-04T19:21:38.893895+00:00 | 2 | 0.788 | — | 1 | 613283 | no | pass |
| 193 | 2026-11-04T19:21:41.470172+00:00 | 2 | 0.574 | — | 1 | 613282 | no | pass |
| 194 | 2026-11-04T19:21:44.059468+00:00 | 2 | 0.583 | — | 1 | 613283 | no | pass |
| 195 | 2026-11-04T19:21:46.683743+00:00 | 2 | 0.62 | — | 1 | 613282 | no | pass |
| 196 | 2026-11-04T19:21:49.291810+00:00 | 2 | 0.601 | — | 1 | 613284 | no | pass |
| 197 | 2026-11-04T19:21:51.964950+00:00 | 2 | 0.666 | — | 1 | 613285 | no | pass |
| 198 | 2026-11-04T19:21:54.632102+00:00 | 2 | 0.66 | — | 1 | 613283 | no | pass |
| 199 | 2026-11-04T19:21:57.230288+00:00 | 2 | 0.591 | — | 1 | 613282 | no | pass |
| 200 | 2026-11-04T19:21:59.971386+00:00 | 2 | 0.739 | — | 1 | 613283 | no | pass |

### newspapers batch 2

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:22:04.516948+00:00 | 2 | 0.579 | — | 1 | 613284 | no | pass |
| 2 | 2026-11-04T19:22:07.166545+00:00 | 2 | 0.647 | — | 1 | 613282 | no | pass |
| 3 | 2026-11-04T19:22:10.106569+00:00 | 2 | 0.934 | — | 1 | 613285 | no | pass |
| 4 | 2026-11-04T19:22:12.754504+00:00 | 2 | 0.641 | — | 1 | 613283 | no | pass |
| 5 | 2026-11-04T19:22:15.373841+00:00 | 2 | 0.613 | — | 1 | 613285 | no | pass |
| 6 | 2026-11-04T19:22:18.043013+00:00 | 2 | 0.667 | — | 1 | 613283 | no | pass |
| 7 | 2026-11-04T19:22:21.739439+00:00 | 2 | 1.692 | — | 1 | 613284 | no | pass |
| 8 | 2026-11-04T19:22:24.391284+00:00 | 2 | 0.645 | — | 1 | 613282 | no | pass |
| 9 | 2026-11-04T19:22:27.001897+00:00 | 2 | 0.604 | — | 1 | 613283 | no | pass |
| 10 | 2026-11-04T19:22:29.621557+00:00 | 2 | 0.616 | — | 1 | 613283 | no | pass |
| 11 | 2026-11-04T19:22:34.549389+00:00 | 2 | 2.926 | — | 1 | 613285 | no | pass |
| 12 | 2026-11-04T19:22:37.449670+00:00 | 2 | 0.893 | — | 1 | 613283 | no | pass |
| 13 | 2026-11-04T19:22:40.048691+00:00 | 2 | 0.595 | — | 1 | 613283 | no | pass |
| 14 | 2026-11-04T19:22:43.107861+00:00 | 2 | 1.052 | — | 1 | 613285 | no | pass |
| 15 | 2026-11-04T19:22:45.758241+00:00 | 2 | 0.648 | — | 1 | 613283 | no | pass |
| 16 | 2026-11-04T19:22:48.758954+00:00 | 2 | 0.995 | — | 1 | 613285 | no | pass |
| 17 | 2026-11-04T19:22:51.520718+00:00 | 2 | 0.756 | — | 1 | 613283 | no | pass |
| 18 | 2026-11-04T19:22:54.430003+00:00 | 2 | 0.906 | — | 1 | 613283 | no | pass |
| 19 | 2026-11-04T19:22:57.130591+00:00 | 2 | 0.697 | — | 1 | 613282 | no | pass |
| 20 | 2026-11-04T19:22:59.846836+00:00 | 2 | 0.71 | — | 1 | 613282 | no | pass |

### newspapers batch 3

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:23:05.026401+00:00 | 2 | 0.639 | — | 1 | 613282 | no | pass |
| 2 | 2026-11-04T19:23:07.669414+00:00 | 2 | 0.636 | — | 1 | 613282 | no | pass |
| 3 | 2026-11-04T19:23:10.258333+00:00 | 2 | 0.582 | — | 1 | 613283 | no | pass |
| 4 | 2026-11-04T19:23:12.635399+00:00 | 0 | 0.37 | — | None | 689763 | yes | failed |
| 5 | 2026-11-04T19:23:15.222307+00:00 | 2 | 0.584 | — | 1 | 613282 | no | pass |
| 6 | 2026-11-04T19:23:17.862219+00:00 | 2 | 0.635 | — | 1 | 613285 | no | pass |
| 7 | 2026-11-04T19:23:20.518366+00:00 | 2 | 0.65 | — | 1 | 613285 | no | pass |
| 8 | 2026-11-04T19:23:23.144306+00:00 | 2 | 0.623 | — | 1 | 613285 | no | pass |
| 9 | 2026-11-04T19:23:25.843164+00:00 | 2 | 0.695 | — | 1 | 613285 | no | pass |
| 10 | 2026-11-04T19:23:28.462634+00:00 | 2 | 0.615 | — | 1 | 613282 | no | pass |
| 11 | 2026-11-04T19:23:31.208888+00:00 | 2 | 0.741 | — | 1 | 613284 | no | pass |
| 12 | 2026-11-04T19:23:33.836979+00:00 | 2 | 0.625 | — | 1 | 613284 | no | pass |
| 13 | 2026-11-04T19:23:36.489837+00:00 | 2 | 0.651 | — | 1 | 613283 | no | pass |
| 14 | 2026-11-04T19:23:39.137855+00:00 | 2 | 0.643 | — | 1 | 613282 | no | pass |
| 15 | 2026-11-04T19:23:41.721104+00:00 | 2 | 0.58 | — | 1 | 613282 | no | pass |
| 16 | 2026-11-04T19:23:44.389699+00:00 | 2 | 0.663 | — | 1 | 613284 | no | pass |
| 17 | 2026-11-04T19:23:46.997625+00:00 | 2 | 0.606 | — | 1 | 613283 | no | pass |
| 18 | 2026-11-04T19:23:49.679879+00:00 | 2 | 0.675 | — | 1 | 613284 | no | pass |
| 19 | 2026-11-04T19:23:52.279596+00:00 | 2 | 0.594 | — | 1 | 613282 | no | pass |
| 20 | 2026-11-04T19:23:54.913333+00:00 | 2 | 0.631 | — | 1 | 613285 | no | pass |

### newspapers batch 4

| Read | Time, UTC | Payloads | Seconds | HTTP status | Rung | Direct bytes reported | Challenge | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 2026-11-04T19:23:59.459002+00:00 | 2 | 0.588 | — | 1 | 613282 | no | pass |
| 2 | 2026-11-04T19:24:02.172711+00:00 | 2 | 0.707 | — | 1 | 613284 | no | pass |
| 3 | 2026-11-04T19:24:04.810327+00:00 | 2 | 0.633 | — | 1 | 613282 | no | pass |
| 4 | 2026-11-04T19:24:07.440230+00:00 | 2 | 0.624 | — | 1 | 613285 | no | pass |
| 5 | 2026-11-04T19:24:10.457458+00:00 | 2 | 1.013 | — | 1 | 613283 | no | pass |
| 6 | 2026-11-04T19:24:13.192543+00:00 | 2 | 0.731 | — | 1 | 613282 | no | pass |
| 7 | 2026-11-04T19:24:15.835417+00:00 | 2 | 0.636 | — | 1 | 613282 | no | pass |
| 8 | 2026-11-04T19:24:18.633126+00:00 | 2 | 0.791 | — | 1 | 613285 | no | pass |
| 9 | 2026-11-04T19:24:21.373726+00:00 | 2 | 0.734 | — | 1 | 613282 | no | pass |
| 10 | 2026-11-04T19:24:24.044942+00:00 | 2 | 0.665 | — | 1 | 613285 | no | pass |
| 11 | 2026-11-04T19:24:26.801554+00:00 | 2 | 0.753 | — | 1 | 613282 | no | pass |
| 12 | 2026-11-04T19:24:29.401492+00:00 | 2 | 0.593 | — | 1 | 613282 | no | pass |
| 13 | 2026-11-04T19:24:32.141054+00:00 | 2 | 0.734 | — | 1 | 613283 | no | pass |
| 14 | 2026-11-04T19:24:34.814026+00:00 | 2 | 0.669 | — | 1 | 613282 | no | pass |
| 15 | 2026-11-04T19:24:37.492422+00:00 | 2 | 0.672 | — | 1 | 613283 | no | pass |
| 16 | 2026-11-04T19:24:40.068637+00:00 | 2 | 0.571 | — | 1 | 613285 | no | pass |
| 17 | 2026-11-04T19:24:42.729172+00:00 | 2 | 0.655 | — | 1 | 613283 | no | pass |
| 18 | 2026-11-04T19:24:45.459868+00:00 | 2 | 0.721 | — | 1 | 613283 | no | pass |
| 19 | 2026-11-04T19:24:48.165541+00:00 | 2 | 0.697 | — | 1 | 613282 | no | pass |
| 20 | 2026-11-04T19:24:50.844902+00:00 | 2 | 0.668 | — | 1 | 613282 | no | pass |

## Local login-code bridge, 4 November 2026

The owner authorized local Apple Mail and Messages solely for a code needed by a current authorized login, including future sites. Global Claude instructions record that permission, with Codex linked to the same file; Mosaic’s tooling documents the on-demand helper.

Mail automation and both local databases passed access checks without reading message content. An initial broad Apple-event search exceeded its twenty-second timeout, so the helper now narrows candidates through Mail’s read-only index before reading a matching message. The JavaScript native archive fixture could not invoke its initializer; the native Swift archive reader passed the synthetic round trip.

Synthetic Mail checks accepted the intended account and sender while excluding a different recipient, a spoofed sender domain and a stale message. Password-reset messages were excluded, multiple codes were rejected as ambiguous, and an expired request was refused. Synthetic Messages checks matched the requested service and phone suffix and excluded a different phone, a different service, an old code and a password reset.

Synthetic service checks also passed owner binding, URL changes, expiry, one-time submission, account confirmation and code masking. They used no network or native input.

TypeScript passed and the existing secret-handling file passed all seven tests. No real message content was read, no login code was printed or stored, and these local checks used zero residential bytes. Successful completion of an actual site’s email or SMS challenge remains unverified until such a challenge occurs.

The service endpoint waits for a collector-free deployment window. The preceding verified application remains `b2da0b3`.

## Ancestry-family login persistence, 5 November 2026

- **Refused password.** About 25 sign-ins from fresh profiles on 4 November ended with Ancestry answering the correct password with "Your email or password is incorrect". The owner's own browser signed in normally. Typing was ruled out: 24 of 24 random strings with the credentials' shape landed exactly through the login's X11 path. The daily check added about a dozen more attempts from test profiles at 00:03 UTC.
- **Known device.** A profile that passed the emailed new-device check stayed signed in to all three sites from a different exit. Collectors had fetched on `residential-US` while logins ran on `ancestry`; both now use `ancestry`, which signed in to all three without a password.
- **Cookie lifetimes** (`GET /v1/sessions/:id/cookie-lifetimes`, no values):

  | Site | Sign-in cookies | Expiry |
  |---|---|---|
  | Ancestry | `SecureATT`, `ANCATT`, `RMEATT`; session `ATT`, `ANCSESSIONID` | about 400 days; `SecureATT` reissued on visit |
  | Newspapers.com | `ncom-rt`; `user_token` 12 h; `ncom-session` 30 min | 30 days; renewed through Ancestry sign-on |
  | Fold3 | `sess` | 30 days; renewed through Ancestry sign-on |

  Ancestry's sign-in form has no remember-me checkbox. Named profiles restore session cookies, so the daily check keeps the login indefinitely.
- **Checker changes** (`4faffe1`): skip refused passwords and unanswered codes, run when two slots are free, and remove test identities with `DELETE /v1/logins/:identity`. The idempotency table now evicts finished operations instead of refusing all keyed calls after 128 (`01a9c98`).
