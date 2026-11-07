# Deployment

Railway runs the combined API and dashboard from the root Dockerfile. Read `/v1/health` for the deployed revision and installed Chrome version; measurement history is in [STEALTH.md](STEALTH.md).

For team deployment, use the [gateway and private-worker procedure](TEAM.md#provisioning). The gateway and each worker require separate volumes and keys. Set `STEEL_IMAGE=gateway` on the gateway service to select its smaller Docker image; workers use the default `browser` image. Railway supplies declared [Docker build arguments from service variables](https://docs.railway.com/builds/dockerfiles#using-variables-at-build-time).

`STEEL_ROLE` selects `gateway`, `worker` or the existing `standalone` behavior; it defaults to standalone in the browser image. The gateway image requires the gateway role and has its own start command. Worker health responses contain readiness only. Both runtime images use the pinned Debian Bookworm slim Node base and a UTF-8 locale for file names.

## Service

This is the current single-org deployment. Its one database, content key and
bucket do not establish isolation for multiple customer organizations. Follow
the [organization delivery sequence](TOOLSTACK-PLAN.md#organization-delivery)
before expanding access; [ORGANIZATIONS.md](ORGANIZATIONS.md) defines the target.

| Item | Value |
| --- | --- |
| Project / service | `vigilant-peace` / `Steel Browser` (Toolstack) |
| Source | `lostprojects/toolstack`, branch `deploy`; synchronize `main` when pushing |
| Watched paths | `/api/**`, `/ui/**`, `/Dockerfile`, `/package.json`, `/package-lock.json`, excluding Markdown; documentation and `mosaic/` changes do not deploy |
| Public URL | `https://steel-browser-production-e8d5.up.railway.app` |
| Health | `/health` and `/v1/health`, public |
| Dashboard | `/ui/?apiKey=<key>` once per browser; an HttpOnly cookie authenticates subsequent requests |
| Persistent volume | `/data`, mounted by one replica |

The API relays session-specific CDP and VNC traffic on its service port. Each browser has its own loopback debugging port. An idle service has no browser process.

## Deployment and rollback

Check live sessions and recent Railway HTTP traffic before pushing application changes. Compare log timestamps locally and omit query strings from diagnostic output, since CDP URLs can contain keys.

Record the currently healthy deployment and verify that its persisted-state formats match the proposed update. Select that recent compatible deployment for rollback. Early phase images may lack the current vault and caller APIs and are unsuitable as routine fallback targets.

SIGTERM stops new sessions, waits up to 120 seconds for current work, then closes browsers and flushes named profiles. Railway cannot overlap deployments using this volume, so allow a brief outage. After deployment, verify health and fresh session creation/release; changes to login behavior also need a retained-login observation.

Use `rw status vigilant-peace`, `rw deploys vigilant-peace "Steel Browser"` and `rw logs …` for inspection. `rw` mutations are dry runs until repeated with `--commit`. Preserve the recorded rollback target until the new revision has passed its relevant checks.

Organization migration adds Library schema version 2 and encrypted gateway format
version 2. Retain a current organization-aware image for rollback; an earlier image
cannot safely write the migrated schema. Restore an earlier release only with its
matching database and volume backups in an isolated destination. Preserve the
organization ID, content key and vault key through deployment and restoration.

## Railway configuration

| Variable | Value or role |
| --- | --- |
| `DOMAIN` | `${{RAILWAY_PUBLIC_DOMAIN}}`, the canonical browser origin |
| `USE_SSL` | `true` |
| `STEEL_API_KEY` | Required admin secret; absent or blank values stop startup |
| `STEEL_AGENT_KEYS` | JSON named-key configuration; production includes `mosaic` |
| `VAULT_KEY` | 32 random bytes encoded as 64 hexadecimal characters |
| `EVOMI_RESIDENTIAL_PROXY_URL` | Service-owned Evomi Core credentials |
| `RESIDENTIAL_DAILY_BUDGET_BYTES` | `1000000000` per named key, reset at midnight UTC |
| `MAX_SESSIONS` | `3` for new workers; preserve `12` on the existing owner worker |
| `MAX_HTTP_FETCHES` | Optional concurrency override, 1–64; default is four helpers per detected CPU, capped at 64 |
| `HTTP_MEMORY_BUDGET_MB` | Optional HTTP memory reservation budget in MiB; default is one quarter of the worker's detected memory limit |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `120` |
| `CHROME_HEADLESS` | `false` |
| `ENABLE_COMMANDS_API` | `true` |
| `CAPTURE_CONSOLE_EVENTS` | `false`; avoids Runtime/Log console subscriptions |
| `ENABLE_PDF_VIEWER` | `true` |

The Dockerfile pins Chrome's package version and SHA-256. Update both together and repeat the relevant browser checks before deployment. Chrome's launcher limits its process group to eight available CPUs. Python HTTP fetching uses pinned `curl_cffi` in `/opt/browser-fetch`.

HTTP admission reserves memory for the helper and its bounded response copies.
Streamed files reserve only a small response prefix. New work also needs spare
V8 heap and, on Linux, physical memory headroom within the host and worker
limits. The Linux check allows for reclaimable filesystem cache.
The remaining memory budget is available to Chrome and the API.

Bursts wait in arrival order for up to five seconds within the existing request
deadline. The queue holds at most twice the concurrency limit; cancellation
removes waiting work immediately, and active reservations last until the helper
exits. A full or expired queue returns 429 with `Retry-After: 1`. A buffered request larger than the
memory budget returns 413; use streamed file delivery for large files. Neither
condition changes the target's working route or triggers browser escalation.

The admin response from `GET /v1/usage` includes `http` capacity, active/queued
counts, reservations and cumulative wait/rejection counters. These defaults
are starting budgets; size overrides from representative load measurements.

Sessions own their Xvfb and x11vnc children. Native input uses `xdotool`; display capture uses `ffmpeg`. The API key protects viewer assets and connections, and protected identities refuse live viewing.

## Content storage

The resources below belong to the initial organization. Startup backfills legacy
content and refuses a database already bound to another organization. Future organizations require independently
provisioned data services, database services and private buckets, each with its
own credentials and encryption keys. Shared control services need separate
storage for identity, membership and subscription metadata.

The dedicated `Toolstack Postgres` service in `vigilant-peace` uses its own
`/var/lib/postgresql/data` volume and pinned PostgreSQL 18 SSL image. The application
connects as `toolstack_app` over TLS. Daily and weekly Railway volume backups are
enabled; an initialization backup is recorded. PMS and Mosaic databases are
independent.

Wasabi bucket `toolstack-content-bbbe0a8e` in `us-east-1` holds encrypted package
files. Its dedicated IAM key permits access only to that bucket and its
`packages/*` objects. Operator bootstrap configuration stays in
`~/nosync.nosync/-env/toolstack.env` with mode 0600. The application receives
only the eight runtime variables in [Library configuration](LIBRARY.md#configuration-and-operation);
root database credentials and Wasabi administration keys stay outside its runtime.

Before multi-tenant rollout, split schema/migration ownership from the request
role and enforce organization/personal-resource row policies. Today `toolstack_app`
owns the Library tables and runs their additive migration. Its restricted server
privileges do not establish a tenant isolation boundary.

The standalone owner service hosts the library initially. Move this configuration
to the gateway before converting the owner service to `STEEL_ROLE=worker`. Workers
use their assigned reader key and refuse central database/encryption credentials.

That gateway arrangement is the existing single-org team path. The multi-tenant
target separates storage authority into an organization data service. Current
worker readers require the organization header, and signed claims include the
organization and membership. Preserve
the current endpoint, volume and vault key during the initial migration. Keep
legacy keys mapped to that organization only; remove unscoped fallback behavior
from tenant-aware paths. Backups, restore and key rotation need organization-bound
procedures before serving an unrelated customer.

API keys and logins retain the existing encrypted vault and profile storage below.
The new database stores content ownership, instructions, grants and file metadata;
publishing content leaves account access unchanged.

## Persistent state

| Path | Purpose |
| --- | --- |
| `/data/.toolstack-organization` | Immutable organization binding; startup refuses reuse across organizations |
| `/data/.toolstack-membership` | Team worker membership binding, alongside its legacy `.steel-user` marker |
| `/data/profiles` | Named Chrome profiles and `mosaic-session-cookies.json` files |
| `/data/vault` | AES-256-GCM encrypted login entries |
| `/data/connections.json` | Profile metadata and API credential references, grants and limits; no credentials |
| `/data/api-executions.jsonl` | Durable API reservations and execution metadata; no queries, response bodies or credentials |
| `/data/routing` | Sticky allocations, byte accounting, host policies and caller outcomes |
| `/data/logins.json` | Last successful login metadata |
| `/data/login-daily.json` | Daily-check scheduling state |
| `/data/login-checks.jsonl` | Read-only member observations and device-check metadata |
| `/data/hathitrust-google-attempt.json` | Persistent single-attempt limit for Google login |

API tools require the existing `VAULT_KEY` and a permitted vault entry. Preserve
`api-executions.jsonl` with that key to retain retry protection. One worker owns
the journal; replicas must not share its volume. Old connection files load with
an empty API catalog. Once the new format writes `apis`, rollback requires a
version that understands that field. See [SEARCH.md](SEARCH.md) for limits and
retention.

The application framework adds disabled/disconnected connection state and optional
capability, account-binding and connected-app metadata to the API journal. The
gateway adds shared-entry grants to its encrypted state. Existing records load
without changing IDs or grants; new shared entries default to the owner.
After these fields are written, rollback requires a build that accepts them.
Keep gateway and worker signed-identity contracts compatible. A catalog manifest
describes installed contracts; it does not install code.

The owner service received the framework and Library release from isolated source
branch `codex/library-storage-20261107` on 7 November 2026. The existing public
address, profiles, vault key and twelve-session capacity are preserved. The release
uses an uploaded source artifact; health reports a null Git revision for this
deployment. Source commit `2af8f90` records the deployed application. The branch also records
subsequent operator checks and documentation; no source was pushed to GitHub.

The prior healthy deployment, `83b964e7-dbf0-4da3-b6de-6153afc3db03` from
`cda43bf`, remains the immediate rollback target for this rollout. New library
data lives in the separate database and bucket. Once new API connection or shared
account formats are written, use a release compatible with those formats for
rollback. The browser volume backup before release preserves the prior state.
Production gateway deployment and real separate-user acceptance remain open.

Profile cookies are credentials. Keep the volume and `VAULT_KEY` intact through deployments. A missing/invalid key or failed decryption leaves the vault locked. Release removes temporary profiles and raw session files. Published download handoffs retain their prepared payloads until their thirty-minute expiry. Graceful worker shutdown removes them, since their temporary links cannot survive a restart. The existing orphan sweep removes abandoned file directories after twenty-four hours.

The daily timer observes Ancestry-family member pages without entering credentials. Other eligible identity checks can run their existing login flow. Busy profiles, insufficient pool capacity, refused credentials and unanswered codes defer attempts; Google is excluded. See [USAGE.md](USAGE.md#phase-5-observations-and-fault-checks) for observation and diagnostic endpoints.

Pending email/SMS code requests exist only in API memory. A deployment invalidates them; the local caller must begin a fresh authorized sign-in. The Mac's code-only helper requires no server daemon or new mailbox access.

## Local credentials and development

Local service settings are held in `~/nosync.nosync/-env/global.env` and Mosaic's `.env`. Railway holds the corresponding server secrets. `STEEL_AGENT_KEY` is the local named client key matching its entry in `STEEL_AGENT_KEYS`; `STEEL_API_KEY` is for administration.

`RAILWAY_TOKEN` in the global file is a workspace token used by `rw`. The historical Premium proxy setting is unused by the current managed allocator. Do not remove shared credential entries merely because this service no longer reads them.

For local Compose and source development, follow [README.md](README.md#local-development). Source development uses `DOMAIN=localhost:5173`; Compose uses `localhost:3000`. Browser origin checks remain enabled in both setups.
