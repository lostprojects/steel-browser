# Independent Toolstack deployments

The repo supplies a private dashboard service and independently deployed browser
and durable-jobs runtimes. The existing public API address, browser volume and
credentials remain on `Steel Browser`. This does not activate the separate team
gateway or move organization data into personal browser workers.

| Service | Build selection | Responsibilities |
| --- | --- | --- |
| `Steel Browser` | Root Dockerfile, `STEEL_IMAGE=browser` | Authenticated API, browser sessions, current organization services, forwarding dashboard requests |
| `Toolstack web` | `deployment/railway/web.Dockerfile` | Private static dashboard, no credentials or persistent volume |
| `Toolstack jobs` | Root Dockerfile, `STEEL_IMAGE=jobs` | Existing durable executor, no browser or dashboard |

The API's existing authentication hook checks dashboard requests and removes URL
keys before forwarding their paths to `TOOLSTACK_UI_ORIGIN`. Only conditional
cache headers travel to the static service; credentials and query strings do not.
The static service must have no public domain or TCP proxy. API/CDP/WebSocket/MCP
traffic continues on its existing route without an extra proxy. API-key cookies
and `DOMAIN` therefore retain the same public origin.

UI changes deploy only the dashboard. Browser/API changes watch `api/` and native
fetch code. The executor watches jobs and their shared Library/organization
modules. Root dependency and Dockerfile changes can rebuild several services.
The default Dockerfile target remains the combined `standalone` runtime, preserving
existing local Compose and rollback behavior. Set `STEEL_IMAGE` explicitly on split
services; the browser build then has no dependency on the UI build stage.

## Preview

```sh
node deployment/railway/plan.mjs web
node deployment/railway/plan.mjs browser
node deployment/railway/plan.mjs jobs
```

Run from the repo root. The helper invokes `rw` dry runs and has no apply mode.
The profiles describe managed service settings, not automatically loaded Railway
config files. Use the Railway skill's approval procedure before applying them.
A new service's preview uses an ID placeholder until creation returns its real ID.

## Release order

1. Reconcile the unfinished local work and the currently uploaded Railway release
   before publishing a GitHub deployment branch. `deploy` must include the intended
   organization, jobs and fetch changes as well as this split; connecting stale
   GitHub code would replace the newer uploaded release. Record a current compatible
   rollback image and follow the backup/session checks in `DEPLOYMENT.md`.
2. Create private `Toolstack web`, apply its profile and connect the reviewed source.
   It needs only `PORT=8080`. Confirm its internal DNS name and `/healthz`.
3. Configure the existing owner service with `STEEL_IMAGE=browser` and
   `TOOLSTACK_UI_ORIGIN=http://toolstack-web.railway.internal:8080`. Preserve its
   current `PORT`, public domain, `DOMAIN`, role, keys, volume and session capacity.
   Clear custom build/start overrides if present, then deploy the reviewed source.
4. Verify dashboard login, cookie-based asset requests, direct API authentication,
   a fresh session and CDP/live-view connections. Existing browser-volume deployments
   need the usual drain window. A later dashboard deployment should leave session
   IDs and the browser process running.
5. Keep the existing jobs provisioning and authorization procedure in `JOBS.md`.
   The jobs profile only selects the image and deployment paths; it does not supply
   the executor's database, organization, content encryption, bucket or control-key
   configuration. Finish that procedure before connecting/deploying the production
   executor. Do not reuse the temporary verification service as production.

No volume move, key rotation or database migration is required for the dashboard
split. Preserve the browser volume and current organization-aware runtime for
rollback. To return to a combined image, select `STEEL_IMAGE=standalone`, remove
`TOOLSTACK_UI_ORIGIN` and restore the prior watch paths. Leave queued work in the
existing Postgres when stopping or rolling back the executor.
