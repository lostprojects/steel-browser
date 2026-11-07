# Toolstack implementation

Toolstack owns its toolkit registry, account connections and execution policy. Browser
profiles and API credentials remain on the authenticated user's worker. Toolkits
call their providers directly; Toolstack's platform does not depend on Composio.

This fork provides independent browsers with durable identities and service-owned authentication. The root guides describe current behavior. [TOOLSTACK-PLAN.md](TOOLSTACK-PLAN.md) owns product direction and acceptance requirements.

The deployed application currently serves one real organization and its owner.
Its fixed organization is required at production startup. Membership IDs are
stable UUIDs derived from that organization and immutable user aliases. Signed
claims, Library ownership and storage bindings carry this identity. The
[organization contract](ORGANIZATIONS.md) distinguishes these implemented controls
from the work required before serving unrelated organizations.

Team mode uses separate worker services and volumes as the user boundary. Its gateway authenticates personal keys, browser sign-ins and approved OAuth apps, then proxies requests only to their fixed worker. Owner operations manage invitations and the global store without an impersonation endpoint. [TEAM.md](TEAM.md) defines this mode and its limits. The session pool described below runs within one user's worker or the legacy standalone service.

History and browser state belong to the authenticated user for every session. Selecting a shared credential does not change the worker or grant access to another user's activity.

## Responsibilities

| Component | Owns |
| --- | --- |
| `SessionPool` | Capacity, identity locks, session ownership and shutdown draining |
| `BrowserSession` | Chrome, display, profile, command engine and browser event storage |
| `ProxyManager` | Evomi Core allocations, exit/timezone checks and durable byte budgets |
| `OperationRunner` | Deadlines, cancellation, retry identities and shared/exclusive resource access |
| `Routing` | Site defaults, validated escalation and cleanup of late browser launches |
| `LoginService` and vault | Agent-scoped credentials, service-owned input and verification outcomes |
| `ToolRegistry` | Versioned tools, discovery, validation and shared execution authorization |
| Connection services | Typed browser/API metadata, direct account resolution and grants |
| `ApiExecutor` and `ApiLedger` | Scoped provider execution, durable usage reservations and private metadata history |
| `ExaClient` | Fixed provider endpoints, bounded retrieval and normalized results |
| Native API definitions | Provider credential contracts, schemas, estimates and bounded actions |
| Workflow manifests | Versioned methods, exact dependencies and declared reference hashes |
| REST and MCP | Authenticated access to the same session operations |
| Application | Library, catalog-driven Toolkits, Connections, Activity and Browser views |
| `ContentLibrary` | Postgres-owned content records and versions, private/assigned/global grants and encrypted Wasabi file retrieval in the current single-org model |
| Hosted gateway | Browser sign-in, OAuth app approval and routing to the user's worker |
| File deliveries | Immutable payloads, browser download links and bounded expiry after session close |
| Mosaic Python clients | Caller validation, reconnects and delivery of files or login codes |

Each browser owns a profile and a loopback debugging endpoint. On Linux it also owns an X display. API clients select sessions explicitly, and named profiles allow only one holder at a time.

## Operation execution

REST and MCP call `BrowserApplication` directly. Both paths validate inputs and check session ownership in the application layer; MCP does not dispatch internal HTTP requests.

`OperationRunner` schedules browser commands, routing fetches, login and delivery preparation. Its operations expose a deadline and cancellation signal. Shared access permits concurrent browser reads and transfers; command batches and login acquire exclusive access in arrival order, so new work cannot prolong a waiting login.

The response can finish before the worker stops. The runner retains session access until the worker, interruption cleanup and any pending work finish. Releasing a session cancels its operations; routing also releases browser launches that complete after cancellation.

Retry keys are scoped to the caller and operation arguments. A pre-action failure can release its identity only when the adapter explicitly permits it. A failure after `markActed()` retains the identity and reports an uncertain effect, so a lost response cannot silently repeat a submitted form. Commands retain their existing execution envelopes, partial results and recovery tokens.

Connector code can import the same runner from `@toolstack/api/operations` without importing browser command handlers. A connector should pass the operation signal to its transport and call `markActed()` immediately before issuing a request that can change remote state.

Native API modules register through `apiToolkits`. The provider-independent
connection schema stores references and policy; `ApiExecutor` owns dispatch and
accounting. Exa and Muse share bounded response parsing. Zero-cost reads still
consume call allowances. Retry fingerprints include the toolkit version and
credential scope, and connected apps have separate retry identities.

The application and MCP use one `ToolRegistry`. Owned content declares its owner
and private, assigned or global visibility. The registry checks the authenticated
person for discovery, methods, references and execution. Worker administration
does not bypass another person's content scope. Account and tool grants still
apply independently. The Muse content module requires explicit owner registration;
it is absent from the app's default catalog. Persistent editing and publication
are implemented by `ContentLibrary`, exposed through Library REST routes and
the generic MCP library toolkit. Organization and membership checks precede
storage access. Promoting personal packages into organization ownership remains
future work.

Workflow methods and references
load on demand, with exact dependency versions and content hashes. Their release
manifest describes installed contracts; code updates require coordinated worker
releases. Durable compute jobs and persistent workflow artifacts remain outside
this short-operation runner.

## Browser modes

| | Agent | Quiet |
| --- | --- | --- |
| Browser control | Puppeteer backend and per-session instrumentation | Direct CDP backend |
| Reads | Existing commands and extraction utilities | Isolated-world reads without Runtime/Log subscriptions |
| Input | CDP | Native X11 input |
| Images | CDP capture | X display capture |
| Network | Direct or managed residential | Direct or managed residential, according to site defaults/options |
| Profiles | Temporary or named | Temporary or named |

Commands depend on the service-owned `BrowserControl`, `PageRead` and `ControlSession` interfaces in `browser-control.ts`. DOM and accessibility algorithms retain typed protocol access; input and capture use explicit backend methods. `AgentBrowser` confines Puppeteer integration and its private target hooks to the agent backend. `QuietBrowser` implements the contract directly. Each page owns its readiness check, and frame readers request child sessions without access to the underlying connection.

Both backends forward existing target/session crash notifications to the tab
registry. A crashed iframe invalidates its command session and saved references,
including when another CDP session receives the first crash notification.
Fault fixtures wait for Chrome's confirmed crash before measuring recovery;
their operation deadlines remain unchanged.

Session details expose `browserCapabilities`. Quiet mode supports native input and visible-display capture; full-page or element capture, image quality settings, PDF printing and network-idle waits return `not_actionable` with reason `unsupported` before activation or scrolling.

Protected identities use the site's enforced profile and residential allocation. Their output restrictions apply regardless of a caller's preferred mode. Quiet mode requires Linux display tools; normal agent development also works on macOS.

Measured launch settings are defined in code. Google Chrome is pinned by version and checksum, with a PDF viewer and a consistent exit timezone. Raw CDP remains available for compatible clients, subject to login, file and protected-output restrictions.

## Session lifetime and persistence

The configured `MAX_SESSIONS` sets each worker's browser capacity. A full pool queues briefly before returning 429; a second claim on a named profile returns 409. Session expiry uses a ten-minute idle timeout and a three-hour lifetime cap.

Named Chrome profiles live on `/data/profiles`. The service separately saves session cookies at normal release so Chrome restarts preserve them. Sites can still expire or revoke authentication; persistence provides no indefinite-login guarantee.

A deployment drains active work for up to 120 seconds, closes browsers and retains profile state. The single mounted volume prevents overlapping deployments. Choose a recent compatible rollback before making application changes.

Startup and release share one lifecycle record, including profile preparation and startup hooks. Release removes a session from live lookups and waits for startup before closing its resources.

Cleanup attempts each resource even when an earlier step fails, then reports the collected errors. The service owns process signals and waits for every session's cleanup during shutdown; metadata failures cannot skip browser cleanup.

## Credentials and access

The encrypted vault stores site credentials and optional TOTP seeds. Its key comes from the service environment; proxy-provider credentials also remain server-side environment settings. Named agents can use only the vault entries that authorize them.

Login reserves the session before entering credentials, waits for earlier work and holds new REST commands until it finishes. Email/SMS verification uses short-lived requests bound to the owner, session and login URL. Mosaic's local code-only helper follows the owner's standing permission.

API authentication is required at startup. Browser requests use the configured service origin; native clients use their existing keys. Protected profiles refuse image capture and profile export. An authorized client's arbitrary scripts still have significant access, so these controls do not amount to full browser isolation.

## Routing and budgets

Anonymous reads can escalate from HTTP with Chrome TLS to a direct agent browser, then to a quiet residential browser. A response passes only after payload validation. Explicit empty results must be validated as carefully as nonempty results.

Authenticated traffic stays on its identity's allocation. Throwaway quiet retries may use one fresh exit; protected identities retain their sticky allocation. Managed sessions resolve the exit timezone before Chrome starts. A custom proxy requires the caller to supply its matching timezone.

Measured policies can send selected static hosts directly and refuse selected advertising hosts. Unknown and challenge hosts retain the residential route. Signed CDN downloads may use direct fetching with residential fallback under the existing download policy.

Daily residential budgets default to 1 GB per named key. Metering includes open tunnels and retains settled totals across restarts. Routing policies and caller outcomes use the same persistent data volume.

## Interfaces and observations

REST and the stateless HTTP MCP endpoint share session ownership and vault permissions. The existing Mosaic Python browser modules supply reconnection and bounded retries. Fetch cancellation stops further escalation and prevents a stopped request ID from creating new work.

Hosted MCP clients connect with the service URL and approve access in a browser.
They manage their own OAuth tokens, without a local runtime. Download links and
the dashboard use ordinary browser saves. Published file handoffs retain only
their prepared payloads for thirty minutes after publication, independently of
the browser session; the worker's existing expiry timer removes them.

The dashboard selects a session explicitly. Browser event logs are bounded in memory and available as JSON or SSE; quiet sessions produce no instrumentation stream. Durable caller outcomes and login observations contain metadata, with source bodies and account values excluded.

The live viewer uses the session's CDP screencast or noVNC display. Protected identities refuse viewing. Human handoff requires the owner's agreement; named clients cannot issue their own approval tokens.
