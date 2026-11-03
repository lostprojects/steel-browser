# Review: is Steel the right foundation for Mosaic's remote browser?

> **Superseded decision.** On 3 November 2026 the owner chose to adapt this fork into Mosaic's own browser service while retaining Browserbase as a fallback. [DESIGN.md](DESIGN.md) is the plan. The findings, risks, practice gaps and test plan below still apply; the recommendation to replace Steel does not. Browserbase remains a fallback.

Written 2 November 2026 from the fork at `ebc49c3`, the Railway deploy logs for `vigilant-peace / Steel Browser`, Mosaic's browser layer and published sources. Nothing was run against the service. Claims marked **[read]** were checked in code or logs; **[source]** claims come from the linked page; **[vendor]** marks a vendor's description of its own product; **[inference]** is reasoning that still needs a measurement.

## 1. Verdict

Replace Steel's server and keep everything the fork has learned. The stealth work is sound and carries over unchanged: headful Chrome on Xvfb, no fingerprint spoofing, quiet CDP through Patchright, software WebGL, PDF plugins, a sticky residential exit and a client-supplied timezone. Steel itself is a poor base for unattended use. Most of the fork's fixes switched off things Steel's own server does, and several faults that remain are part of its design.

The build is not yet robust enough to run unattended. Every job shares one Chrome profile that is never wiped, and a "persistent" login is lost on the next deploy. A second client silently kills the first client's session, and abandoned sessions never time out. Every push, including documentation, redeploys and kills whatever is running, and each rebuild can change the Chromium version untested.

These can be patched inside Steel, but each patch widens the fork against a beta upstream that documents a concurrency of one. The simpler path is a small image of our own built from the same parts: Google Chrome, Xvfb, a noVNC view for manual logins, and a supervisor of a few hundred lines. That image has no server-side CDP client at all, so the class of leaks the fork spent most of its effort closing cannot recur.

Keep Browserbase as the fallback, and measure it with our own Evomi proxy before building anything. Browserbase accepts an external proxy from its $20 Developer plan **[source]**. If it does not meter that traffic per GB, it may already meet the cost goal with no operations at all, and the self-hosted build becomes a choice the owner can decline.

## 2. Recommended design

### What we are trying to do

Mosaic needs to borrow a real desktop browser for one job, on a residential IP, and give it back. One identity, the Ancestry login, must be remembered between jobs. Everything else should start clean.

That gives three real objects, each with a natural primitive:

| Object | Primitive | Lifetime |
|---|---|---|
| A session | One Chrome process | Start on request, end on release, idle timeout or crash |
| An identity | One Chrome profile directory | Throwaway per job, or named and kept on a volume (`ancestry`) |
| A network exit | One local forwarder to one Evomi sticky session | Same as the session |

Steel adds a fourth thing between these: a long-lived Node server holding one Puppeteer connection to one always-running browser, which it reuses, relaunches and instruments. Our problems come from that layer.

| Steel layer | What it cost us |
|---|---|
| Fingerprint injection | Contradictions; switched off (`SKIP_FINGERPRINT_INJECTION`) |
| Puppeteer attached to every target | `Runtime.enable` leak; replaced with a patched 2024 Puppeteer (`rebrowser-puppeteer-core@23.6.101` against Chrome 156) **[read]** |
| Console capture | Detected CDP; switched off (`CAPTURE_CONSOLE_EVENTS`) |
| Default Chrome flags | WebGL disabled, PDF viewer removed; overridden by variables and a code change |
| Ad blocking | `blockAds: true` routes every request through Node with `Fetch.enable` on `*` **[read]**. Puppeteer 23 keeps the cache on, so the cost is latency and a stall if Node stalls |
| Session manager | Singleton browser, shared profile, ignored `userDataDir`, no timeout (§3) |

What Steel gives us that we actually use is small: a session endpoint, a CDP WebSocket pass-through, a proxy forwarder with byte counts, an API key (which we added) and a live view.

### The design

One Railway service with a volume, built from a short Dockerfile:

- **Google Chrome stable** from Google's apt repository, installed at a recorded version. Upgrade it on purpose every two to four weeks and re-run the tests. Chrome reaches a new milestone every two weeks (M156 stable 20 October, M157 3 November 2026, [chromiumdash](https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=157)), so a pinned version must not be left to age.
- **Xvfb**, one display per session, at a common desktop size.
- **x11vnc and noVNC** behind the API key, for watching a session and for the manual Ancestry login. This replaces Steel's live view and the Browserbase live-view URL without any CDP.
- **Desktop fonts and Mesa** (`fonts-liberation`, `fonts-noto`, `fonts-noto-color-emoji`, `libgl1-mesa-dri`).
- **A supervisor** in Python (aiohttp), about 300 lines, written to Mosaic's script rules:
  - `GET /health` with no key. It reports the supervisor, Xvfb and live sessions.
  - `POST /sessions {profile, proxy, timezone, locale}` returns a CDP URL and a view URL. It returns 409 when a named profile is in use and 429 at `MAX_SESSIONS`.
  - `DELETE /sessions/{id}` ends a session.
  - `WS /cdp/{id}` pipes bytes to Chrome's local DevTools port with `Host: localhost`. The supervisor never parses or sends CDP itself.
  - An in-process forwarder per session handles CONNECT and plain HTTP, adds Evomi's credentials and counts bytes. `gost` or `pproxy` would do the same job as a separate binary.
  - Chrome is launched with the fork's current flags, `--user-data-dir`, `--remote-debugging-address=127.0.0.1`, `--lang`, `TZ` and `DISPLAY`. Run it under `taskset` so it sees 8 cores; measure whether `navigator.hardwareConcurrency` follows in the page and in workers before relying on it.
  - Each session ends on release, on an idle timeout (no CDP client for 10 minutes), on a lifetime cap (3 hours) or when Chrome exits. Throwaway profiles are deleted when the session ends.
  - On SIGTERM it stops accepting sessions, waits up to the draining period, then closes Chrome normally so the profile flushes to disk.
  - It logs one JSON line per session: profile, duration, bytes, Chrome exit code and end reason.

Mosaic gets one client module, `scripts/browser/remote.py`, that opens a session on either backend and returns a Patchright page. Callers name a profile (`ancestry` or throwaway) and whether they need a residential exit. The module picks the sticky Evomi session, looks up the exit's timezone through it, checks after connecting that the page's timezone matches, and retries once on a new exit. It then falls back to Browserbase.

### Why this is the simplest design that meets the needs

- **Fewer moving parts.** Chrome is already a CDP server. The only code we own is the supervisor and the forwarder, and neither touches pages.
- **Clean by construction.** Each job starts a fresh process and, unless it names a profile, a fresh profile. Memory growth and cookie carry-over between jobs cannot happen.
- **Parallel sessions cost nothing in design.** Run more processes up to `MAX_SESSIONS`, with one lock per named profile. Whether to use them stays the owner's decision (§7).
- **One upstream to track.** Chrome's version is the only external dependency that affects detection. Patchright is on the client and already in Mosaic's `.venv`.
- **No idle browser.** Steel keeps a browser running between sessions **[read]**. This design starts Chrome only when a job asks, so idle cost is the supervisor alone.

### The alternatives compared

| Option | Fits our needs | Main problems | Verdict |
|---|---|---|---|
| Steel fork as it stands | Passes all six routes in supervised runs | Problems listed in §3; beta upstream at v0.5.5 with 81 open issues; Steel's own guide says self-hosted runs at concurrency 1 and scaling is "your responsibility" ([releases](https://github.com/steel-dev/steel-browser/releases), [Steel guide, 1 Apr 2026](https://llms.steel.dev/articles/self-hosted-browser-infrastructure-guide/)) | Use as the bridge only |
| Steel fork, patched further | Same | Five or more new fork changes; the server-side CDP client remains | Rejected: same effort as the minimal image, more drift |
| Minimal image of our own | All needs, including parallel sessions and a durable login | We own about 300 lines and a Dockerfile | **Recommended** |
| Browserless self-hosted | Mature queueing, timeouts and health checks | SSPL licence; stealth and persistent sessions are paid features; its own server-side automation is unaudited ([repo](https://github.com/browserless/browserless), [config](https://docs.browserless.io/enterprise/docker/config)) | Rejected |
| `kernel-images` | Same shape as ours: headful Chromium, Xvfb, noVNC or WebRTC, CDP on 9222; Apache 2.0 | No tagged releases; auth, proxy forwarding and profile policy would still be ours ([repo](https://github.com/kernel/kernel-images)) | Read its Dockerfile as a reference |
| Camoufox server | Strong Firefox-level spoofing; releases resumed in 2026 | Speaks Playwright's protocol instead of CDP, so Patchright cannot drive it; persistent contexts cannot be served ([repo](https://github.com/daijro/camoufox)) | Keep in reserve for one site that defeats Chrome |
| nodriver or zendriver service | Strong Turnstile results in one benchmark | Client libraries only (AGPL); no maintained server | Borrow its techniques, such as the checkbox click |
| CloakBrowser | Patched Chromium with built-in proxy and timezone matching | Closed binary with a licence key; one session on the free tier ([repo](https://github.com/CloakHQ/CloakBrowser)) **[vendor]** | Rejected |
| Browserbase with our Evomi proxy | No operations; persistent contexts; live view | $20/month plus $0.12 per browser-hour; unclear whether external-proxy bytes are metered ([proxies](https://docs.browserbase.com/features/proxies), [pricing](https://www.browserbase.com/pricing)) | **Fallback, and measure first** |
| Browser Use Cloud with our proxy | $0.02 per hour plus $0.20/GB for our own proxy **[vendor]** ([pricing](https://browser-use.com/pricing)) | Presents Chrome on macOS from Linux hosts (survey below); profiles unverified | Second fallback candidate |
| Steel Cloud | Our proxy on all plans | Sessions capped at 15 minutes on Launch ([pricing](https://steel.dev/pricing)) **[vendor]** | Rejected for logins |
| Kernel, Anchor, Hyperbrowser | Capable | Our own proxy needs a $200, $500 or Enterprise plan **[vendor]** | Rejected on cost |

An independent survey of 11 hosted browser services on 23 April 2026 found every one detectable, with Steel Cloud at 15 rule hits and Browserbase at 12 ([incoherency.co.uk, 24 Apr 2026](https://incoherency.co.uk/blog/stories/stealth-browser-survey-april-2026.html)). Hosted services save operations work, but none of them was undetectable.

## 3. Risks of the current build

Ranked by likelihood times cost in unattended use.

| # | Risk | Likelihood | Impact | Fix |
|---|---|---|---|---|
| 1 | **One profile for every job.** Non-persistent sessions all use `/tmp/steel-chrome`, which nothing deletes between sessions **[read]**: no removal code exists, and the launch log shows the same directory every time. Cookies such as `cf_clearance`, DDoS-Guard tokens and any login carry from one job into the next on a different exit IP. Cloudflare ties clearance to the visitor and device ([Cloudflare docs, 23 Oct 2026](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)). | Certain | Challenges on later jobs; jobs become linkable to each other | Throwaway profile per session |
| 2 | **Persistent logins are lost on deploy.** `options.userDataDir \|\| options.persist === true ? <fixed path> : <tmp>` ignores the caller's path (upstream [#347](https://github.com/steel-dev/steel-browser/issues/347)) and writes inside the image, which Railway discards on redeploy **[read]**. There is no volume. | Certain | The Ancestry login cannot move from Browserbase | Named profile on a Railway volume |
| 3 | **A second client kills the first.** A new session replaces the running one (`USAGE.md`; `launchInternal` shuts down the existing browser) **[read]**. Mosaic runs agents in parallel, so two collector jobs at once is likely. The first sees only a dropped socket. | High | Lost work that looks like a site failure | Refuse with 409 or run separate processes |
| 4 | **Every push redeploys and kills sessions.** 13 deploys between 31 October and 3 November, several from documentation commits **[read]**. Railway's overlap and draining both default to 0 ([Railway deployments](https://docs.railway.com/reference/deployments)). | High while the fork is active | A killed job; with a volume, brief downtime | Watch paths that skip `*.md`, deploy from a `deploy` branch, set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` |
| 5 | **The browser version drifts silently.** The Dockerfile runs `apt-get dist-upgrade` and installs Debian's `chromium` unpinned **[read]**. Any rebuild, including a docs push, can change the browser that was tested. | High | A detection change no one measured | Pin the Chrome version; record it in `/health` |
| 6 | **No session timeout.** `timeout` is always 0 and no timer exists (upstream #350) **[read]**. An interrupted client leaves Chrome open on a residential exit until the next session. | Medium | Small proxy spend; a logged-in page left polling | Idle timeout and lifetime cap |
| 7 | **The exit IP changes under a running session.** A hardsession keeps an IP "for as long as Evomi can" (`USAGE.md`). `TZ` is fixed at launch, so a new exit in another zone recreates the timezone contradiction. Long logged-in sessions are the most exposed. | Medium on long sessions; unmeasured | Re-authentication or challenge mid-job | Client checks the exit IP every few minutes and restarts the session if it changes |
| 8 | **Chrome crashes.** On disconnect Steel ends the session and relaunches an idle browser **[read]**, so recovery exists. Mosaic's client has no retry. The GPU process already crashed once under ANGLE with `--in-process-gpu` (`STEALTH.md`). | Low per job, higher on long WebGL-heavy pages | A failed job | Client retries once; the supervisor reports the exit code |
| 9 | **Upstream drift.** Seven fork changes over a beta upstream, with Puppeteer pinned at 23.6 against Chrome 156 **[read]**. Every merge needs a full re-measure. | Medium | Silent regression after a merge | Removed by the minimal image |
| 10 | **A server-like profile.** 48 cores, 32 GB, llvmpipe and a Chromium brand together read as a server more than a desktop (§4). | Medium on the hardest targets | Lower pass rate on DDoS-Guard and Turnstile | Google Chrome; cap cores; measure |
| 11 | **Every request paused in Node** when `blockAds: true`, which `USAGE.md` recommends **[read]** | Low | Hangs if Node stalls; blocked ad hosts can break pages | Send `blockAds: false` now |

Memory growth inside Steel's server is not a risk: its event log is capped at 10,000 events **[read]**. `pastSessions` grows without limit but holds a few hundred bytes per session.

### The timezone finding needs correcting

The Railway logs do not support "Steel's lookup returned Railway's location in three of three sessions" **[read]**. Through the proxy, Steel resolved `America/New_York`, `America/Chicago`, `America/Los_Angeles` and, once after a timeout, `UTC`.

The `America/New_York` lines that follow every release come from the idle browser relaunching with the server's own direct lookup. Railway's US-East host resolves to New York, which looks like the reported symptom.

The real causes are more likely these two:

- **IP rotation.** Those tests used `session-<id>_lifetime-30`, which `USAGE.md` says may change IP. Steel's lookup and the browser could leave through different IPs.
- **Database disagreement.** Steel took the first answer from three geolocation services, while the client checked with ipwho.is alone.

The hardsession change and the client-side timezone landed in one commit (`097cb0d`), so the logs cannot separate the two. Keeping the client lookup is right. Use one geolocation service for both setting and checking, and check from inside the page after connecting.

## 4. Gaps against November 2026 practice

### What already matches

| Practice | Our build | Source |
|---|---|---|
| Stay truthful; detectors hunt contradictions between the UA, platform, GPU and workers | Spoofing off, Linux reported as Linux | [Castle, LinkedIn's checks, 16 Jan 2026](https://blog.castle.io/detecting-forged-browser-fingerprints-for-bot-detection-lessons-from-linkedin/); [Castle, roll your own detection, Oct 2025](https://blog.castle.io/roll-your-own-bot-detection-fingerprinting-javascript-part-1/) |
| Headful beats headless | Headful on Xvfb | Headless blocked on 15.2% of top sites against 7.2% headed ([Bamberg, ARES 2026](https://psi.uni-bamberg.de/en/forschung/bot-detection/)) |
| Avoid `Runtime.enable` and console domains | Patchright client, patched server Puppeteer, console capture off | [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches); [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) |
| Let Chrome's own TLS and HTTP/2 reach the site | CONNECT tunnel through a local forwarder | [pydoll proxy notes](https://pydoll.tech/docs/deep-dive/network/proxy-detection/) |
| Block WebRTC from bypassing the proxy | `--webrtc-ip-handling-policy=disable_non_proxied_udp` and `--force-webrtc-ip-handling-policy` are in the launch log **[read]** | [invisible_playwright wiki](https://github.com/feder-cr/invisible_playwright/wiki/webrtc-leak-proxy) |
| Timezone matched to exit before the first page | Client-supplied `timezone` | [MaxMind accuracy notes](https://support.maxmind.com/hc/en-us/articles/4407630607131) **[vendor]** |
| One sticky exit per job | Evomi hardsession | Same |

The fork's account of the CDP leak needs a footnote. Castle reports that V8 stopped running user getters during console serialization in May 2025, which killed the classic `Error.stack` check ([Castle, 28 Aug 2025](https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/)). deviceandbrowserinfo.com still flagged CDP until all three fixes landed, so it detects something else. The fixes stand on the measurement; the mechanism described in `STEALTH.md` is probably out of date.

### What is missing

1. **Google Chrome instead of Debian Chromium.** Chromium's `Sec-CH-UA` and `userAgentData.brands` omit "Google Chrome" ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-CH-UA)). Debian builds proprietary codecs, so H.264 answers match ([Debian rules](https://salsa.debian.org/chromium-team/chromium/-/raw/master/debian/rules)), but the Widevine module is probably absent **[inference]**. The only reproducible 2026 benchmark found real Chrome mattered more than stealth patches on a Turnstile page ([Paterson, 13 May 2026, updated 15 Aug](https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/)). It is a single machine and target, so treat it as one data point.
2. **A pinned, current version.** See risk 5 and the milestone cadence above.
3. **A less server-like machine.** Castle treats Mesa as normal on Linux but generic software renderers as anomalies ([Castle, WebGL renderer, Feb 2025](https://blog.castle.io/the-role-of-webgl-renderer-in-browser-fingerprinting/)). Vendors list llvmpipe as a server signal ([Scrapfly, June 2026](https://scrapfly.io/blog/posts/how-cloudflare-detects-bots)) **[vendor]**. 48 cores alone is not flagged; Castle's sample rule fires above 90 ([Castle, Oct 2025](https://blog.castle.io/deep-dive-how-navigator-devicememory-can-be-used-for-fingerprinting-and-bot-detection/)). llvmpipe is what a GPU-less Linux desktop really shows, so keep it, and bring the core count down to a desktop figure.
4. **The exit node's operating system.** Through a residential proxy the target sees the exit device's TCP stack. A Windows or Android stack behind a Linux UA is a mismatch, and the April survey found this the most common weakness ([incoherency.co.uk](https://incoherency.co.uk/blog/stories/stealth-browser-survey-april-2026.html)). We cannot choose Evomi's devices, so measure it and see whether failures cluster on non-Linux exits.
5. **OS-level clicks for challenges.** A CDP mouse click inside a cross-origin iframe reports `screenX`/`screenY` relative to the iframe, and Turnstile reads this ([WebScraper.io, 24 Oct 2025](https://webscraper.io/blog/google-patches-100-precise-cloudflare-turnstile-bot-check)). Whether Chrome 156 fixed it is unknown. The DDoS-Guard checkbox click in `STEALTH.md` goes through CDP. On Xvfb, `xdotool` gives a real X11 click, which is what SeleniumBase UC does with pyautogui.
6. **Some human input.** Cloudflare lists human behaviour among Turnstile's checks ([Turnstile docs, Aug 2026](https://developers.cloudflare.com/turnstile/)), and zero input events on load is a known bot signal ([Scrapfly](https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-turnstile)) **[vendor]**. A few curved pointer moves and a scroll while a challenge runs is cheap ([ghost-cursor](https://www.npmjs.com/package/ghost-cursor)).
7. **Explicit language.** Set `--lang=en-US` and Accept-Language to match the exit country, and record `navigator.languages` in the probe.
8. **IP reputation is shared.** In one September 2026 sample, 84.7% of a "private" provider's exits were already attributed to other proxy operators ([Castle, 17 Sep 2026](https://blog.castle.io/what-sits-behind-a-private-proxy-network/)). Retrying on a new sticky session is the realistic remedy; switching provider rarely buys clean IPs.
9. **A CDP-leak test.** Add [bot-detector.rebrowser.net](https://bot-detector.rebrowser.net/) to the probe; deviceandbrowserinfo.com alone is one opinion.

## 5. Migration plan

Each step ends with a check. Browserbase stays the default until step 8 passes.

1. **Stop accidental redeploys.** On the current service, add watch paths that skip `*.md` and `mosaic/**`, and set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120`. Send `blockAds: false` from the client. *Check:* a docs-only push creates no deploy.
2. **One client for both backends.** Add `scripts/browser/remote.py` to Mosaic with `backend="browserbase" | "steel"`, Patchright, the sticky exit and the timezone check. Leave every caller on Browserbase. *Check:* Utah Digital Newspapers loads through each backend once.
3. **Baseline before building.** Run the six routes ten times each on three set-ups: today's Browserbase configuration, Browserbase with our Evomi proxy, and the current Steel service. Ask Browserbase support whether external-proxy bytes count against the GB allowance. *Check:* a table of pass rate, time and bytes per route. Decide here whether to build at all (open question 2).
4. **Build the minimal image** as a new Railway service in `vigilant-peace` with a volume, from a new repository or a `server/` directory in this one. *Check:* `/health` reports the pinned Chrome version, and one throwaway session passes the fingerprint stage of §6.
5. **Routes on the new service.** *Check:* route pass marks in §6, and no route worse than the Steel and Browserbase baselines.
6. **Move the throwaway-profile callers one at a time**, each with Browserbase fallback on failure, in order of risk: `fetch_news.py` (UDN), `companies_fetch.py` (Bizapedia), then `aa.py`. *Check:* a week of normal use per caller with a fallback rate under 10%.
7. **Move the Ancestry family.** Log in once through the noVNC view into the `ancestry` profile on the volume, pinned to one exit region. Switch `bb_session.py` callers to `remote.py` with `profile="ancestry"`. *Check:* the logged-in marks in §6.
8. **Soak and fault tests** in §6. *Check:* every mark met.
9. **Switch the default.** Make the new service the default in `remote.py`, update `.claude/tooling.md`, and record the service in `.claude/infrastructure.md`. Keep the Browserbase fallback.
10. **Retire.** Delete the Steel service after two clean weeks. After 30 days, move Browserbase to the cheapest plan that still allows our proxy.

## 6. Test plan

Each stage needs the previous one to pass. Run through Evomi Core unless stated. Record the exit IP, the TCP operating-system guess and the Chrome version on every run.

The baseline and route stages together spend roughly 200 MB of residential traffic, about 20 cents at Evomi's price **[inference, from the byte counts in `STEALTH.md`]**.

### Fingerprint, 20 sessions on 20 exits

| Check | Pass mark |
|---|---|
| deviceandbrowserinfo.com bot test | No flags in 20 of 20 |
| bot-detector.rebrowser.net | Every CDP and automation test green, with Patchright connected |
| `navigator.webdriver` | `false` |
| Brands | Include "Google Chrome" at the pinned version |
| Timezone against exit (same geolocation service) | Match in 20 of 20 |
| `hardwareConcurrency` | The same in page, dedicated worker and service worker, at 16 or less |
| WebRTC (browserleaks.com/webrtc) | No address except the exit's |
| WebGL | llvmpipe through ANGLE, stable across sessions |
| CreepJS, BrowserScan, Pixelscan | Record only. No "lie" or headless markers in CreepJS; Pixelscan's changelog records past Linux false positives ([changelog](https://pixelscan.net/changelog)), so its Linux verdicts are advisory |

### Routes, 20 runs each across at least 10 exits

| Route | Pass mark |
|---|---|
| Utah Digital Newspapers, Newspapers.com sign-in, Fold3 login, Ancestry sign-in | 19 of 20 |
| Bizapedia people page | 18 of 20 |
| Anna's Archive search | 16 of 20 first try; 19 of 20 with one retry on a new exit |
| Every route | No worse than the better baseline from step 3 by more than one run |

### Logged-in use

- **Daily jobs.** Daily jobs on Ancestry, Newspapers.com and Fold3 for seven days. *Pass:* no sign-in prompt after the first login, and no new-device check.
- **Survival.** The profile survives two deploys and one `kill -9` of Chrome.
- **One long session.** A three-hour Fold3 viewer session, logging the exit IP every five minutes. *Pass:* Chrome's memory stays under 2 GB and no crash occurs. If the IP changes, the client restarts the session and the site keeps the login.

### Soak and faults

- **Soak.** 200 sessions over 24 hours, mixed routes. *Pass:*
  - no Chrome process left after a session ends
  - supervisor memory back within 50 MB of its start
  - every session ends with a logged reason
  - forwarder errors under 1%
- **Chrome kill.** `kill -9` Chrome mid-page. *Pass:* the client sees an error within 5 seconds and its retry succeeds.
- **Broken upstream proxy.** Use bad credentials, then an address that never answers. *Pass:* a clear error within 30 seconds, and no hang.
- **Deploy during a session.** *Pass:* the session finishes inside the draining period, or the client fails cleanly and Browserbase completes the job.
- **Two clients on `ancestry`.** *Pass:* the second gets 409.
- **Parallel sessions, if wanted.** Three throwaway sessions at once. *Pass:* route pass rates unchanged and memory inside the plan.

### Which detection suites to trust

| Suite | Use |
|---|---|
| Real targets | The only verdict that counts. Paterson saw the same site's verdict change with the site's state, so repeat runs |
| bot-detector.rebrowser.net | CDP and automation leaks |
| deviceandbrowserinfo.com | Overall bot verdict from Castle's author; good for regressions |
| CreepJS | Lies and inconsistencies; ignore the trust score |
| BrowserScan, Pixelscan | Advisory; Pixelscan has a history of Linux false positives |
| Sannysoft, BotD | Too basic to tell us anything new ([BotD](https://github.com/fingerprintjs/BotD) is in maintenance) |

Keep a weekly canary afterwards: one probe and three routes, run from a Railway cron service. It needs an entry in `.claude/infrastructure.md`.

## 7. Open questions for the owner

1. **Parallel sessions.** The minimal design allows several at once at no design cost; Steel allows one. Do collector jobs need to run at the same time, and how many? This sets `MAX_SESSIONS` and the Railway memory limit.
2. **Build, or use Browserbase with our proxy?** If step 3 shows Browserbase with Evomi passes the routes and does not meter external-proxy bytes, it costs $20/month plus $0.12 per browser-hour with no operations. Is that cheap enough, or is owning the browser worth the work? Which Browserbase plan is the account on now?
3. **The Ancestry identity.** Which US region should the login profile live in? Evomi's hardsession may still change IP within it. A static residential or ISP address would be steadier at a higher price.
4. **Manual login.** Is a noVNC page behind the API key acceptable for the one-time login and any two-factor prompt?
5. **CAPTCHAs.** Without paid solvers, DDoS-Guard's text CAPTCHA and an interactive Turnstile need a human through the view, or a fallback to Browserbase's solver. Which do you prefer?
6. **Where the code lives.** A new repository, or a `server/` directory in this fork with Steel's code removed?
7. **Linux or spoofed Windows.** This review recommends staying truthful as Linux. If the TCP measurement shows most Evomi exits are Windows, revisit it with that data.
