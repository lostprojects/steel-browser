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

The owner set both the daily per-agent budget and this run's residential ceiling
to 1,000,000,000 bytes. The phase 3 route table above is the comparison baseline;
it has not been re-measured.

Before deploying phase 4, three updated Mosaic callers ran concurrently on direct
Steel sessions. A fourth received HTTP 429 after the queue and opened Browserbase.
All three pages retained their independent titles. Residential traffic was zero.

TypeScript passed. The existing focused set passed 18 tests with two skipped;
six additional checks passed for durable budgets, identity metadata, route payloads
and the observed challenge-frame cases. Live phase 4 acceptance remains pending.
Browserbase is a temporary fallback until phase 6 moves the callers.

The first phase 4 deployment failed startup because the generated budget schema
used an OpenAPI boolean `exclusiveMinimum`, which Fastify's JSON Schema validator
rejected. No browser session or residential check ran on that image. Production
was rolled back to the accepted phase 3 application; health, direct session creation
and release passed with zero residential bytes.

The fix uses an inclusive one-byte minimum. A Fastify schema-compilation regression
check passed, along with all ten session-pool tests and TypeScript.

The HTTP reader's first local check failed with a TypeError because curl_cffi
responses do not implement a context manager. Switching to `Session.stream`
returned HTTP 200 from example.com, with 579 response bytes. This check used
no residential traffic.
