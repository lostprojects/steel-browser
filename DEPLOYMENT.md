# Deployment

## Service

| Item | Value |
|---|---|
| Railway project / service | `vigilant-peace` / `Steel Browser` |
| Source | `lostprojects/steel-browser`, branch `deploy`. Keep `main` at the same commit. Railway watches `/api/**`, `/ui/**`, `/Dockerfile`, `/package.json`, `/package-lock.json`, excluding `!/**/*.md`; documentation and `mosaic/` changes do not deploy |
| Build | Root `Dockerfile`, which Railway detects |
| URL | `https://steel-browser-production-e8d5.up.railway.app` |
| Health check | `/v1/health`, the only path that needs no key |
| Dashboard | `/ui/?apiKey=<key>` once per browser; an HttpOnly cookie keeps it working |

Before a deployment push, check `GET /v1/sessions` and recent Railway HTTP logs for active jobs. Record the last healthy deployment for `rw rollback`. Railway draining is set to 120 seconds. SIGTERM stops new sessions, lets existing jobs finish during that interval, then closes their browsers and flushes profiles.

`MAX_SESSIONS=3` caps independent browsers. A volume at `/data` holds named profiles; throwaway profiles use unique temporary directories. Railway cannot overlap deployments with this volume, so each deployment causes a short outage.

The health endpoint reports the active session count and free memory. An idle service has no browser process. `ENABLE_COMMANDS_API=true` exposes the per-session commands engine. Only one Railway replica may mount the profile volume.

Manage the service with the `rw` CLI (`rw status`, `rw logs vigilant-peace "Steel Browser"`, `rw vars …`). Every `rw` write is a dry run until repeated with `--commit`.

## Railway variables

| Variable | Value | Purpose |
|---|---|---|
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `120` | Time allowed for the service to drain during deployment |
| `DOMAIN` | `${{RAILWAY_PUBLIC_DOMAIN}}` | Session URLs use the public domain |
| `USE_SSL` | `true` | Session URLs use `https` and `wss` |
| `CDP_REDIRECT_PORT` | set by the template | Internal DevTools port |
| `STEEL_API_KEY` | secret | Turns on the key check. Without it the service is open to anyone |
| `CHROME_HEADLESS` | `false` | Headful Chrome on Xvfb. Headless mode exposes `HeadlessChrome` in the user agent, an 800×600 screen and no plugins |
| `MAX_SESSIONS` | `3` | Maximum concurrent browser processes |
| `ENABLE_COMMANDS_API` | `true` | Per-session commands API |
| `CAPTURE_CONSOLE_EVENTS` | `false` | Stops Steel listening to page and worker consoles, which pages detect. Page console output no longer reaches Steel's logs |
| `ENABLE_PDF_VIEWER` | `true` | Keeps Chrome's PDF viewer, so `navigator.plugins` lists the usual five entries. PDFs open in the viewer instead of downloading |

`XVFB_SCREEN` (default `1920x1080x24`) sets the virtual screen. Pages read it from `window.screen`, so keep it a common desktop size.

## Credentials

Values live in two files and nowhere else, under the same names:

- `/Users/moi/nosync.nosync/-env/global.env`, for any project on this machine
- `/Users/moi/nosync.nosync/Mosaic/.env`, because Mosaic scripts read only their own project file

| Name | What |
|---|---|
| `STEEL_URL` | The service URL |
| `STEEL_API_KEY` | Must match the Railway variable. When rotating it, change Railway and both files |
| `EVOMI_RESIDENTIAL_PROXY_URL` | Evomi Core Residential, `http://user:pass@core-residential.evomi.com:1000`. The default for every job |
| `EVOMI_PREMIUM_PROXY_URL` | Evomi Premium Residential. In testing it passed nothing that Core failed, so reserve it for a site that blocks Core's IPs |

The Railway token for `rw` is `RAILWAY_TOKEN` in `global.env`, a workspace token for the "Projects" workspace.

The launch profile now includes the measured WebGL and WebRTC flags in code. Legacy fingerprint and extra Chrome-argument variables are unused. Browserbase remains the client fallback; this phase does not change Mosaic scripts.
