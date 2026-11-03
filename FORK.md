# Changes from upstream

The fork is Mosaic's browser service. It retains Steel's commands, extraction utilities and live view, with a session pool replacing the singleton browser services.

Phase 1 removes the idle browser, Selenium and fingerprint injection. Each session owns its browser, forwarder and profile; routes select it by ID. `SessionPool.registerSessionHook()` lets integrations register fresh plugin instances or launch/shutdown callbacks before each browser starts.

Google Chrome stable is installed at an exact version and checksum. Each session owns an Xvfb display and a loopback VNC endpoint; noVNC uses the existing API key. The global display and unpinned Debian Chromium install are removed.

Phase 2 passed after the owner accepted replacement of incomplete transport and fixture runs. Production runs Google Chrome 156.0.8078.79 with separate displays and noVNC. [STEALTH.md](STEALTH.md) records the 20 complete checks on distinct exits and the incomplete attempts. The phase 3 candidate adds quiet mode; production acceptance is pending.

## Earlier fork fixes

| Commit | Files | Change | Why |
|---|---|---|---|
| `346efeb` | `api/src/services/cdp/cdp.service.ts` | `changeOrigin: true` on the CDP WebSocket proxy | Chrome rejects a DevTools `Host` header that is not `localhost` or an IP, so every CDP client failed with a 500 behind Railway's domain. Same fix as upstream [PR #297](https://github.com/steel-dev/steel-browser/pull/297), still unmerged |
| `346efeb` | `api/src/utils/api-key.ts`, `api/src/index.ts`, `api/src/plugins/browser-socket/browser-socket.ts`, `api/src/env.ts` | Optional `STEEL_API_KEY` | Upstream has no authentication. Without a key, anyone who finds the URL can drive the browser and spend the proxy allowance |
| `47b549b` | `api/entrypoint.sh` | Start Xvfb before the API | The image installs Xvfb and sets `DISPLAY=:10` but never starts it, so headful Chrome failed with "Missing X server or $DISPLAY" |
| `64a0d74` | `api/src/services/timezone-fetcher.service.ts` | Ask ipinfo.io, ip-api.com and ipwho.is at once with a 6 s timeout | Upstream asks ipinfo.io alone with a 2 s timeout, and a failure leaves the browser on UTC. This did not make the lookup reliable on Railway, so clients pass `timezone` themselves ([USAGE.md](USAGE.md#pass-the-timezone-yourself)). `TIMEZONE_SERVICE_URL` still selects a single service |
| `8d4af8a` | `api/package.json`, `package-lock.json` | Alias `puppeteer-core` to `rebrowser-puppeteer-core@23.6.101` | Puppeteer sends `Runtime.enable` to every page and worker. The rebrowser build is the same 23.6.0 release without that call. Imports are unchanged |
| `9933006` | `api/src/env.ts`, `api/src/services/cdp/instrumentation/target-manager.ts` | Optional `CAPTURE_CONSOLE_EVENTS` | Steel's target manager enables `Runtime` and `Log` on every page and worker to log console output. Chrome then serializes console arguments, which pages detect. `false` skips those two domains |
| `fc2ee5f` | `api/src/env.ts`, `api/src/utils/browser.ts`, `api/src/services/session.service.ts`, `api/src/services/cdp/cdp.service.ts` | Optional `ENABLE_PDF_VIEWER` | Upstream disables the PDF viewer so PDFs download, which leaves `navigator.plugins` empty, unlike any desktop Chrome. Both default-preference sites now share `defaultPluginPreferences()` |

WebGL needed no code. Upstream's `FILTER_CHROME_ARGS` and `CHROME_ARGS` variables remove and add the flags; see [DEPLOYMENT.md](DEPLOYMENT.md#railway-variables).

## Repository

| Change | Why |
|---|---|
| Upstream's `README.md`, `CONTRIBUTING.md` and `docs/` moved to [upstream-docs/](upstream-docs/), with links back into the code given a `../` prefix | Keeps upstream's documents intact while the root holds ours |
| Root `README.md`, `USAGE.md`, `DEPLOYMENT.md`, `STEALTH.md` and this file | The fork's own documentation |
| [mosaic/stealth_check.py](mosaic/stealth_check.py) | Measures detection signals and runs the collector routes against the deployed service ([STEALTH.md](STEALTH.md#measuring-detection)) |

`.github/` is upstream's and unchanged. Its workflows and labeler still name the old `docs/`, `README.md` and `CONTRIBUTING.md` paths; GitHub does not run them on this fork unless Actions are enabled.

## Taking upstream fixes

This fork is Mosaic's browser service. Keep the Apache 2.0 licence and notices, and take useful upstream fixes individually with `git cherry-pick`. Do not merge `upstream/main` wholesale.

Typecheck with `cd api && npx tsc --noEmit` and run the tests covering changed modules. Check active sessions and Railway HTTP traffic before pushing a deployment to `deploy`, and keep `main` at the same commit. Railway ignores documentation and the local measurement client when deciding whether to deploy.

## Quiet-mode candidate

Quiet sessions start Chrome as a plain child process. The commands engine uses a direct CDP adapter with isolated-world execution, no Runtime or console subscriptions, and unpaused iframe attachment. Native pointer and keyboard events use the session’s X display; screenshots come from ffmpeg’s X11 capture. Agent sessions keep Puppeteer and their existing instrumentation.
