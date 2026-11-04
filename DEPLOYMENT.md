# Deployment

Production runs the phase 4 implementation with Google Chrome 156.0.8078.79. Live acceptance gaps are recorded in `STEALTH.md`.

Phase 3 passed 20 complete fingerprint results on distinct exits, with owner-approved replacements for incomplete transport and fixture attempts. Documentation and measurement-client pushes remain excluded from deployments.

## Service

| Item | Value |
|---|---|
| Railway project / service | `vigilant-peace` / `Steel Browser` |
| Source | `lostprojects/steel-browser`, branch `deploy`. Keep `main` at the same commit. Railway watches `/api/**`, `/ui/**`, `/Dockerfile`, `/package.json`, `/package-lock.json`, excluding `!/**/*.md`; documentation and `mosaic/` changes do not deploy |
| Build | Root `Dockerfile`, which Railway detects |
| URL | `https://steel-browser-production-e8d5.up.railway.app` |
| Health check | `/v1/health` and `/health` |
| Dashboard | `/ui/?apiKey=<key>` once per browser; an HttpOnly cookie keeps it working |

Before a deployment push, check `GET /v1/sessions` and recent Railway HTTP logs for active jobs. Record the last healthy deployment for `rw rollback`. Railway draining is set to 120 seconds. SIGTERM stops new sessions, lets existing jobs finish during that interval, then closes their browsers and flushes profiles.

`MAX_SESSIONS=3` caps independent browsers. A volume at `/data` holds named profiles; throwaway profiles use unique temporary directories. Railway cannot overlap deployments with this volume, so each deployment causes a short outage.

Health reports the installed Google Chrome version, active session count and free memory. An idle service has no browser process. `ENABLE_COMMANDS_API=true` exposes the per-session commands engine. Only one Railway replica may mount the profile volume.

Manage the service with the `rw` CLI (`rw status`, `rw logs vigilant-peace "Steel Browser"`, `rw vars …`). Every `rw` write is a dry run until repeated with `--commit`.

## Railway variables

| Variable | Value | Purpose |
|---|---|---|
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `120` | Time allowed for the service to drain during deployment |
| `DOMAIN` | `${{RAILWAY_PUBLIC_DOMAIN}}` | Session URLs use the public domain |
| `USE_SSL` | `true` | Session URLs use `https` and `wss` |
| `STEEL_API_KEY` | secret | Turns on the key check. Without it the service is open to anyone |
| `CHROME_HEADLESS` | `false` | Headful Chrome on Xvfb. Headless mode exposes `HeadlessChrome` in the user agent, an 800×600 screen and no plugins |
| `MAX_SESSIONS` | `3` | Maximum concurrent browser processes |
| `ENABLE_COMMANDS_API` | `true` | Per-session commands API |
| `CAPTURE_CONSOLE_EVENTS` | `false` | Stops Steel listening to page and worker consoles, which pages detect. Page console output no longer reaches Steel's logs |
| `ENABLE_PDF_VIEWER` | `true` | Keeps Chrome's PDF viewer, so `navigator.plugins` lists the usual five entries. PDFs open in the viewer instead of downloading |

Session `dimensions` set its own Xvfb screen (default 1920×1080×24). Each session owns Xvfb and x11vnc children, which close when it ends. noVNC assets and the VNC WebSocket require the API key.

The Docker build installs Google Chrome stable `156.0.8078.79-1`, with its SHA-256 pinned in `CHROME_SHA256`. Update both build arguments together; an unavailable version fails with a message to bump it. The launcher limits Chrome and its children to eight available CPUs using `taskset`. No JavaScript fingerprint values are injected. The earlier phase 1 image uses Debian Chromium 156.0.8078.73 and a shared Xvfb display.

## Credentials

Values live in two files and nowhere else, under the same names:

- `/Users/moi/nosync.nosync/-env/global.env`, for any project on this machine
- `/Users/moi/nosync.nosync/Mosaic/.env`, because Mosaic scripts read only their own project file

| Name | What |
|---|---|
| `STEEL_URL` | The service URL |
| `STEEL_API_KEY` | Admin key. Must match Railway and both local files |
| `STEEL_AGENT_KEY` | Named `mosaic` key in both local files; matches its entry in Railway `STEEL_AGENT_KEYS` |
| `EVOMI_RESIDENTIAL_PROXY_URL` | Evomi Core Residential, `http://user:pass@core-residential.evomi.com:1000`. The default for every job |
| `EVOMI_PREMIUM_PROXY_URL` | Evomi Premium Residential. In testing it passed nothing that Core failed, so reserve it for a site that blocks Core's IPs |

The Railway token for `rw` is `RAILWAY_TOKEN` in `global.env`, a workspace token for the "Projects" workspace.

The launch profile now includes the measured WebGL and WebRTC flags in code. Legacy fingerprint and extra Chrome-argument variables are unused. Browserbase is a temporary client fallback until phase 6 moves the callers.

## Quiet mode

Quiet Chrome starts directly with the pinned binary and its own display. The commands connection starts when first requested.

It permits isolated-world reads, refuses instrumentation subscriptions and sends input through `xdotool`; `ffmpeg` captures the display. No new Railway variables are required.

The quiet launch disables `OptimizationHints`, matching the agent launch, because Chrome otherwise downloads Optimization Guide data in the background. Live byte getters include open proxy tunnels, and `proxyTraffic` reports hostname totals without paths or credentials. Released totals remain the final accounting record.

The preceding cleanup application was commit `5174f4d`, deployment `097d4bac-9c8c-4e1e-8230-31f06fb72a0b`. The full phase 3 acceptance measurements came from `bfbc39f`, deployment `89b38d9f-9008-45a5-86e3-4557db263f17`, which remains a known-good rollback target. The older phase 2 target is `6ffa7417-bc73-4f16-8090-59ed3c929e4a`; that older image lacks quiet mode and includes open-tunnel bytes only on release.

The `rw rollback` wrapper now uses the scalar rollback result. Its dry run was
checked against the accepted phase 3 deployment; repeat with `--commit` only when
a rollback is needed.

Current application commit `c364bd5` is deployment `83f16f3c-d9a8-443a-8eb1-e017d6afe797`. Health and direct quiet-session creation/release passed with zero residential bytes.

## Phase 4 settings

Applied with `--skip-deploy` after a dry run, then activated by the phase 4 deployment:

| Variable | Value | Purpose |
|---|---|---|
| `EVOMI_RESIDENTIAL_PROXY_URL` | secret | Server-owned Evomi Core allocation and exit checks |
| `STEEL_AGENT_KEYS` | secret JSON | Named `mosaic` client key; the existing key remains admin |
| `RESIDENTIAL_DAILY_BUDGET_BYTES` | `1000000000` | Daily residential budget per key; midnight UTC reset |

The existing `/data` volume and `MAX_SESSIONS=3` are unchanged. `/data/routing`
holds sticky identity metadata, durable spend and the seven-day host table.
It contains no proxy credentials. Profile cookies remain credentials, including `mosaic-session-cookies.json` in each named profile. The service writes that file on release so session cookies survive Chrome restarts.

The existing one-second expiry timer also samples budgets and settles the ledger.
A thirty-second check flags hosts above 10 MB and ends traffic above 5 MB per
interval after two minutes without navigation. No separate daemon was added.
The image adds Python and pinned `curl_cffi==0.16.3` for bounded HTTP reads.

Use accepted phase 3 deployment `89b38d9f-9008-45a5-86e3-4557db263f17` as the
first rollback target if phase 4 fails health or session creation.

The tested splitting policy is enabled for `annas-archive.pk`, `www.bizapedia.com`,
`newspapers.lib.utah.edu`, `www.ancestry.com`, `www.newspapers.com` and `www.fold3.com`.
Those persisted policy writes changed no Railway variables or volumes.

## Vault and automatic login

`VAULT_KEY` is a 32-byte random key encoded as 64 hexadecimal characters. It was staged with `--skip-deploy`, activated with the 4 November deployment, and stored in both local env files. Values are never printed. The existing `/data` volume holds the AES-256-GCM file `/data/vault`; no new volume is required. A missing or invalid key, or failed authentication of the encrypted file, leaves the vault locked.

The login timer checks previously authenticated identities once per UTC day when the pool is idle. `/data/login-daily.json` prevents repeats across deployments; `/data/login-checks.jsonl` records the outcome, device-check classification and exit IP. `/data/logins.json` preserves each site's last successful login. The timer ends with the API process.

The first vault deployment passed health and fresh quiet-session creation. Subsequent login fixes wait for an empty session list and an idle HTTP log window. The last verified service build is `447c2b4`; vault login acceptance remains incomplete. No volume was added.
