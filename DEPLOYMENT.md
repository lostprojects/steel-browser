# Deployment

## Service

| Item | Value |
|---|---|
| Railway project / service | `vigilant-peace` / `Steel Browser` |
| Source | `lostprojects/steel-browser`, branch `deploy`. Keep `main` at the same commit. Railway watches `/api/**`, `/ui/**`, `/Dockerfile`, `/package.json`, `/package-lock.json`, excluding `!/**/*.md`; documentation and `mosaic/` changes do not deploy |
| Build | Root `Dockerfile`, which Railway detects |
| URL | `https://steel-browser-production-e8d5.up.railway.app` |
| Health check | `/health` and `/v1/health`, both public |
| Dashboard | `/ui/?apiKey=<key>` once per browser; an HttpOnly cookie keeps it working |

Before a deployment push, check `GET /v1/sessions` and recent Railway HTTP logs for active jobs. Record the last healthy deployment for `rw rollback`. Railway draining is set to 120 seconds. SIGTERM stops new sessions, lets existing jobs finish during that interval, then closes their browsers and flushes profiles.

`MAX_SESSIONS=3` caps independent browsers. A volume at `/data` holds named profiles; throwaway profiles use unique temporary directories. Railway cannot overlap deployments with this volume, so each deployment causes a short outage.

The health endpoints report the installed Google Chrome version, active session count and free memory. An idle service has no browser process. `ENABLE_COMMANDS_API=true` exposes the per-session commands engine. Only one Railway replica may mount the profile volume.

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

Session `dimensions` set its own Xvfb screen (default 1920×1080×24). Each session owns Xvfb and x11vnc children, which close when it ends. noVNC assets and the VNC WebSocket require the API key.

The Docker build installs Google Chrome stable `156.0.8078.79-1`, with its SHA-256 pinned in `CHROME_SHA256`. Update both build arguments together; an unavailable version fails with a message to bump it. The launcher limits Chrome and its children to eight available CPUs using `taskset`. No JavaScript fingerprint values are injected.

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
