# Changes from upstream

Toolstack is Mosaic's fork of Steel and keeps its commands engine and extraction utilities. `SessionPool` and `BrowserSession` own independent browsers, replacing the original shared browser lifecycle.

## Product name

Toolstack uses the `@toolstack` npm scope and the `toolstack` CLI. The local checkout is `/Users/moi/nosync.nosync/Toolstack`, with Mosaic's Python client at `scripts/browser/toolstack.py` and the API plugin at `api/src/toolstack-plugin.ts`.

Existing `STEEL_*` settings, HTTP headers and persistent storage identifiers retain their protocol names so deployed clients and saved profiles continue working. The old CLI, Python import and JavaScript exports remain compatibility aliases; new integrations use the Toolstack names.

The GitHub fork is `lostprojects/toolstack`. The deployed service URL and Railway display name retain their existing values.
Further work belongs in [TOOLSTACK-PLAN.md](TOOLSTACK-PLAN.md).

## Runtime

| Area | Current implementation |
| --- | --- |
| Sessions | Configurable browser capacity, exclusive named profiles, bounded queuing, idle/lifetime limits and graceful draining |
| Browser | Pinned Google Chrome with measured launch flags; per-session Xvfb and loopback VNC on Linux |
| Agent mode | Rebrowser Puppeteer with per-session instrumentation and commands |
| Quiet mode | Direct CDP reads in isolated worlds, native X11 input and ffmpeg display capture |
| Proxies | Managed Evomi Core allocations, exit/timezone checks, persistent sticky IDs and per-agent budgets |
| Routing | Payload-validated HTTP/browser escalation, seven-day host policies and measured traffic splitting |
| Logins | AES-256-GCM vault, named-agent permissions, service-owned input and local code-only verification |
| Clients | Scoped REST and MCP interfaces, session reconnection, fetch deadlines and cancellation |

The original Selenium path, fingerprint injection and idle browser are removed. The fixed-port nginx debugger proxy and recording extension are also removed; the API relays each session's CDP and live-view connections directly.

Named profiles save session cookies on release and restore them at the next start. Authenticated requests retain the profile's residential allocation. Browserbase remains a Mosaic fallback while caller observation windows are open.

## Access boundaries

The service requires `STEEL_API_KEY` at startup. Browser-origin requests must match its configured origin; native clients use the existing key header or CDP URL. Dashboard authentication sets an HttpOnly cookie and redirects to a URL without the key.

Chrome and display/HTTP helpers receive an explicit OS environment without service credentials. The CDP relay restricts upload paths and download destinations to session files. Login waits for existing operations and holds new REST commands while the service enters credentials.

Protected identities refuse profile exports and image capture. Responses and logs scrub known secrets. Arbitrary scripts from an authorized browser client remain a substantial privilege.
[The plan](TOOLSTACK-PLAN.md#remaining-browser-work) tracks additional isolation work.

## Dashboard and logging

The dashboard selects sessions by ID and uses session-specific event connections. Quiet sessions collect no browser event stream. Protected profiles display metadata without opening a viewer.

Browser event storage keeps at most 1,000 events per session in memory. `/v1/logs/query` returns JSON and `/v1/logs/stream` provides SSE; supply `sessionId` when multiple browsers exist. The old Parquet endpoint returns 501. Durable caller and login observations use separate metadata files.

The old recorder/page-ID sockets and embedded DevTools panel are removed. The legacy `/v1/devtools/inspector.html` URL remains a redirect to the selected session's viewer. Use the session's CDP endpoint with a compatible external debugging client when needed.

## Integration and maintenance

`SessionPool.registerSessionHook()` registers fresh plugins or lifecycle callbacks before each browser starts. `ToolstackConfig` supports file upload limits, custom WebSocket handlers and enabling the log routes. Removed disk-storage options had no effect in the pooled service.

Take useful upstream fixes individually with `git cherry-pick`. Preserve Apache 2.0 notices. The former upstream setup guides and promotional assets remain in Git history. [COMMANDS.md](COMMANDS.md) retains the command reference with the current session lifecycle.

Run `npm run typecheck -w api`, `npm run typecheck -w ui` and the existing tests covering changed modules. Build with `npm run build`. Regenerate API models and UI types after schema changes using the commands in [ui/README.md](ui/README.md#api-types).

The root Dockerfile serves Railway and local Compose. API builds clear generated output and exclude tests. The final image copies compiled API files and runtime dependencies; source and fixtures stay out of it. Before deploying, follow [DEPLOYMENT.md](DEPLOYMENT.md#deployment-and-rollback); keep `main` and `deploy` synchronized when pushing.

Measurements belong in [STEALTH.md](STEALTH.md); caller migration status belongs in [mosaic/CALLERS.md](mosaic/CALLERS.md). Preserve failed measurements when a later run passes.
