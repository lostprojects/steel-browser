# Using the service

The service runs Google Chrome 156.0.8078.79 with twelve independent browser sessions (`MAX_SESSIONS=12`).
Browserbase remains available. [The plan](TOOLSTACK-PLAN.md#caller-review-and-browserbase-retirement)
defines migration acceptance and retirement requirements.

These interfaces use the deployment's fixed organization. Existing client keys
retain their owner workspace; team-mode keys and OAuth apps resolve to their
registered membership and private worker. `global` sharing applies within this
organization. Authenticated `GET /v1/organization` returns the current organization
and membership. An explicit foreign `x-toolstack-org-id` is refused.

Production requires `TOOLSTACK_ORG_ID`. Missing or forged organization/membership
fields in signed downstream claims are refused. There is one real tenant and no
organization switcher; [ORGANIZATIONS.md](ORGANIZATIONS.md) records expansion work.

## Sessions and identities

Send `steel-api-key` on HTTP requests. Use `STEEL_API_KEY` for administration;
named client keys have separate daily residential budgets of 1 GB (1,000,000,000
bytes). The day changes at midnight UTC. Direct traffic does not use that budget.

Create a direct session with `POST /v1/sessions {"mode":"agent"}`. For a managed
residential exit, send `{"mode":"quiet","residential":{"country":"US"}}`.
The service allocates a Core sticky exit, looks up its IP and timezone through
that exit with ipwho.is, then starts Chrome with the returned timezone.
For a custom `proxyUrl`, also supply the matching `timezone`; the old
`TIMEZONE_SERVICE_URL` setting has been removed.

Add a named `identity` to keep a profile on `/data/profiles`. Ancestry,
Newspapers.com and Fold3 use `identity: "ancestry"` for both login and collection.
Use `mary-ferrell` for Mary Ferrell and `bizapedia` for Bizapedia.
Its sticky ID lives in the service's private routing state. A second claim gets
HTTP 409. Mosaic's client can wait (`identity_policy="wait"`, ten-minute default)
or ask for a throwaway profile (`identity_policy="throwaway"`). Throwaway sessions
receive independent sticky exits and profiles.
Session cookies are saved alongside the profile on release and restored on its
next start. The source identity's local storage is imported during migration.

An administrator can delete an idle identity with `DELETE /v1/identities/{name}`.
It removes the profile, stored sticky allocation and login records, including for
protected identities. A busy identity returns 409; deletion holds its lock until
all removals finish. Vault entries and metered spend remain. Clients sending
a JSON content type should include `{}` as the DELETE body.

A fourth session waits up to five seconds, then gets HTTP 429. Mosaic waits and
retries capacity refusals for up to ten minutes. A busy pool or identity does not
switch providers. Service unavailability can still use the temporary Browserbase
fallback while phase 6 observations remain open.

Create requests accept a caller-generated UUID in `sessionId`. Send an
`idempotency-key` header when retrying a create after a lost response. Reusing the
key with different arguments returns 409.

Connect Patchright to the returned `websocketUrl`, adding `?apiKey=<key>`.
Stock Playwright adds instrumentation that quiet sessions avoid. A dropped API
or CDP connection leaves the browser and page alive; reconnect to that same URL.
Mosaic's `Browser.reconnect()` reattaches, and its API helper retries safe requests.

Release with `POST /v1/sessions/{id}/release`. Without a client or API activity,
sessions expire after ten minutes; the lifetime cap is three hours. Release returns
`endReason`, settled `proxyTxBytes` and `proxyRxBytes`, plus hostname traffic.
Temporary profiles are removed. A budget termination reports
`residential_budget_exceeded`; a busy stream without navigation can end as
`stream_without_navigation`.

## Dashboard and browser logs

Open `/ui/?apiKey=<key>` once to authenticate, then select the session in the
Sessions menu. Starting a browser selects its new ID. Ended sessions retain
metadata; protected profiles show no live view. The dashboard supports both
browser modes and managed residential allocations.

Agent logs use `/v1/sessions/{id}/logs` over WebSocket. HTTP clients can query
`GET /v1/logs/query?sessionId={id}` or stream `/v1/logs/stream?sessionId={id}`.
Browser events are bounded to 1,000 per session in memory. Quiet sessions have no
instrumentation stream. The old Parquet export endpoint returns 501; use JSON
queries for exports. The legacy inspector URL redirects to the live viewer.

## Routing and downloads

`POST /v1/fetch` accepts `url`, an optional collector `route`, `identity` and
`retain`. It tries plain HTTP with Chrome TLS, an agent browser, then a quiet
residential browser. Validation checks the payload, including Utah's valid HTTP
418 responses. Known hosts begin at their recorded rung; entries expire after
seven days. `startRung` requests an explicit starting point for measurement.

The six route names are `annas`, `bizapedia`, `udn`, `ancestry`, `newspapers` and
`fold3`. Anonymous probes carry no identity cookies. Named identities use their
own sticky residential exit throughout. A failed quiet attempt gets one fresh-exit
retry; identity sessions retain their exit and do not retry under another identity.

The result keeps each attempt's outcome, timing and residential bytes separately.
A successful response includes HTML and either a retained session or its settled
record. `GET /v1/routing` shows the host table; `GET /v1/usage` shows durable totals.
Usage separates the current UTC day from cumulative traffic. Admin responses
include cumulative `totalByAgent`; a named key sees its own cumulative
`totalResidentialBytes` alongside its daily `residentialBytes` and budget.

Traffic splitting is off unless a site has an approved policy. It routes a small
static-CDN list directly and refuses a small advertising/media list; unknown hosts,
first-party resources and challenge providers retain the residential exit. Admin
`splitTraffic` permits a detector check before enabling a site with
`PUT /v1/routing/policies/{host} {"split":true}`.

The `bizapedia` identity refuses AdThrive, GumGum, btloader and PrivacyManager
hosts, plus Google advertising and analytics hosts, at the forwarder. Cloudflare
challenge hosts retain the residential exit.
This policy does not enable browser request interception or service-wide ad blocking.

The delivery API stages each file once, then streams its immutable bytes to a
local receiver. Browser downloads use unique Chrome download IDs, preserving
separate files with the same suggested name. Payloads remain private to their
session and agent.

Check [deployment status](TOOLSTACK-PLAN.md#current-baseline) for this protocol.
A server advertising `deliveryVersion: 1` in its session response supports it. The hosted
browser download page receives these deliveries on macOS and Windows without
a local installation. The [automation client](client/README.md) remains optional. Mosaic retains its legacy path for older deployments.

| Request | Result |
| --- | --- |
| `POST /v1/sessions/{id}/transfers` with `{"file":"SESSION_FILE"}` or `{"url":"https://…"}` | Delivery metadata; URL jobs can return `receiving` |
| `GET /v1/sessions/{id}/transfers/{delivery}` | State, original name, byte count, SHA-256 and expiry |
| `POST /v1/sessions/{id}/transfers/{delivery}/share` | Publish a private browser download link that survives browser-session close |
| `GET /v1/sessions/{id}/transfers/{delivery}/content` | Raw streamed bytes; supports `Range` with `If-Match` |
| `POST /v1/sessions/{id}/transfers/{delivery}/ack` with `{"sha256":"…"}` | Consume the remote payload after verified local publication; repeat acknowledgements are safe |
| `DELETE /v1/sessions/{id}/transfers/{delivery}` | Cancel preparation or discard an unwanted payload |

A source URL uses the browser's cookies and managed exit policy. The HTTP helper
writes directly to disk through curl's synchronous callback, applying disk
backpressure without building a base64 body. Delivery metadata contains no
cookies or source URL. Metadata includes status, content and acknowledgement
URLs as applicable. A client must authenticate each request and verify the
advertised digest before acknowledging it.

Deliveries expire after 30 minutes. An active content stream can finish within
its ten-minute read deadline. Session release aborts unfinished preparation
and removes raw session files, unshared payloads and ZIP archives. A shared
handoff keeps only its prepared payload until receipt, explicit removal or
expiry; it keeps no browser running. The existing expiry
timer also removes inactive orphan directories older than 24 hours, including
remnants of an abrupt service failure. Graceful worker shutdown deletes its
remaining handoffs immediately. No additional daemon runs.

`DOWNLOAD_MAX_BYTES` defaults to 512 MiB per file; `DOWNLOAD_PENDING_BYTES`
defaults to 1 GiB reserved per session, including uncollected browser downloads.
Preparations reserve capacity before starting; Chrome cancels downloads that
exceed the limits. `FILES_ROOT` overrides the default `/files` root. ZIP archives are
created only when explicitly requested. Published handoffs share a worker-wide
`DOWNLOAD_HANDOFF_BYTES` budget of 2 GiB and a limit of 1,024 entries.

The legacy `POST /v1/sessions/{id}/download` JSON/base64 endpoint remains for
compatibility, with its 64 MB limit. The portable client and MCP downloads use
deliveries on supporting servers. Byte-returning Python methods still allocate the requested
bytes in memory and keep the remote payload until session cleanup; use
`Browser.download_to(target, directory)` for a streamed local file.

## Challenges and manual input

`POST /v1/sessions/{id}/challenge` waits out interstitials and uses native input
for Cloudflare/Turnstile and DDoS-Guard checkboxes, plus Bizapedia's drag control.
It reads frames through Chrome's inventory, including closed shadow roots.

A visual puzzle returns `challenge_required`, a screenshot and `noVncUrl`. The
session stays open under its idle timeout. Open the view with `?apiKey=<key>`;
its authentication cookie removes the key from subsequent URLs. Other callers can
use the remaining pool slots.

Mosaic's `challenge.py` calls this API and accepts manual actions in screenshot
pixels. The service's `/input` endpoint uses native display input for those actions.
Both clients have removed their duplicate challenge solvers.

Quiet commands use `POST /v1/sessions/{id}/commands`; reads run in isolated worlds
and keyboard/pointer events use X11. Screenshots capture the visible display.
Full-page/element screenshots, scrape actions and CDP casting are unavailable in
quiet mode. Agent sessions retain the existing instrumentation and action routes.

## Existing identity migration

`mosaic/migrate_identity.py FILE` imports the existing US sticky ID, opens the
named profile under its identity lock and checks every unexpired cookie before
release. Keep the source credential file until the login check passes. The updated
client uses the server profile and does not read or overwrite that local file.

The US migration preserved 87 unexpired cookies and 48 local-storage entries.
Subsequent Ancestry-family checks passed on the known-device `ancestry` profile
on 5 November UTC. The unused local migrated context has been deleted.

## Vault login

The API requires its admin key at startup and validates configured named keys.
Browser-origin requests, including WebSockets, must come from the configured
service origin. Native clients can continue using their existing headers and CDP
URLs without an Origin header. Opening a dashboard or live view with `apiKey`
sets the existing HttpOnly cookie and redirects to a URL without the key.

REST commands, native input, challenges and authenticated HTTP reads wait while
the service signs in. Login first gives existing operations up to thirty seconds
to finish; if they remain active it returns 409 before entering credentials.
Raw CDP retains its existing limited setup access during login.

Raw CDP uploads and drag-and-drop files use the same session-directory checks as
the commands API, including resolved symlinks. Browser download destinations are
fixed to that session's files directory. Upload files through the files API before
selecting them in a page.

Chrome and its display and HTTP helpers receive only the OS environment settings
they need. Service keys and proxy credentials are omitted. Existing profiles,
cookie formats and automatic verification-code handling are preserved.

An administrator imports values with `PUT /v1/vault/{name}` using `fields` and `allowedAgents`. `GET /v1/vault` and `GET /v1/vault/{name}` return names, field names and last-use times. `mosaic/vault_import.py` transfers the selected project env fields through that API without printing values.

Create a quiet session with identity `ancestry` or `mary-ferrell`, then call `POST /v1/sessions/{id}/login {"site":"ancestry"}`. The Ancestry identity also accepts sites `newspapers` and `fold3`. The service validates account content, types through X11 and records `last_login_ok`. `current:true` checks the present page and signs in again when it observes signed-out controls. An unrecognized page returns `unchecked`; it does not establish authentication.

Protected identities require access to their vault entry and use a fixed sticky residential allocation throughout. `/request` sends authenticated GET or POST requests over that same exit. Signed CDN downloads can try direct egress. Protected profile exports and image capture are refused because they can expose login details; text responses and CDP replies are scrubbed.

Two-step outcomes remain explicit. Stored authenticator seeds generate TOTP codes at use. Email and SMS code fields issue a local code request; other device checks retain their classification. HathiTrust Google uses the protected identity `hathitrust` and vault entry `hathitrust-google`. The flow permits one attempt, preserved across deployment in `/data/hathitrust-google-attempt.json`. It stops on an insecure-browser response or unsupported challenge; later calls return `not_attempted` / `google_attempt_limit`. It does not try other identity providers or enroll a seed. The service does not request a manual login.

Mosaic’s Mary Ferrell caller uses this API. The three Ancestry-family `login`
commands and collection sessions use the `ancestry` identity. Sign in to these
sites only on that known-device identity; stop on `credentials_rejected`.

Direct acceptance can bound `/fetch` with `maxRung:2` (or `1` for HTTP). An administrator may set `forceDirectFailure:true` to exercise the remaining ladder in one request. `/routing/policies/{host}` accepts `startRung` and `ttlSeconds`; temporary learned escalation expires back to that configured starting rung. Failure injection is an explicit test condition.

`mosaic/stealth_check.py direct-soak STATE_DIR --immediate` removes the eight-hour gaps and stops routes that have already failed acceptance. Use repeatable `--route annas`, `--route udn` or `--route newspapers` options to select routes; omitting them checks all three.

Its output establishes immediate performance; it does not establish 24-hour stability. Read-only HTTP probes omit idempotency keys, while session mutations retain them.

## Local email and SMS codes

The owner permits local Apple Mail or Messages access solely for a code needed by a current authorized login, including future sites. Mosaic’s `Browser.ensure_login()` invokes its code-only helper automatically when the service exposes a compatible code field.

`GET /v1/sessions/{id}/login/code` returns an active request or null. `POST` to the same path accepts `{"requestId":"…","code":"…"}` in the body; use an idempotency key for transport retries. Do not put codes in URLs, shell arguments, logs or agent output.

The request belongs to the same agent, identity and session and expires after at most five minutes. Submission consumes it, verifies the unchanged login URL and code channel, types through X11 and checks authenticated content. A fresh login replaces an older request.

Mosaic’s `scripts/browser/login_codes.py --session ID` reads only messages since that login attempt, within ten minutes, matching the configured service and account. It sends a unique code directly and reports status; no message or code is stored. See [Mosaic tooling](../Mosaic/.claude/tooling.md#local-login-codes) for local availability and future adapter requirements.

This adds no mailbox watcher and gives Railway no access to local message history. The daily service check records an unanswered challenge when no local caller is present. Google’s flow uses the same code bridge only for a supported verification field in that single attempt.

## Phase 5 observations and fault checks

The daily timer runs every minute and checks each eligible site once per UTC day
when two pool slots are free. On `ancestry`, it reads the tree dashboard,
Newspapers.com Edit Profile and a Fold3 Project Blue Book search using the retained
login. It enters no credentials and records any sign-in prompt or device check.
HTML remains in memory; the history contains flags, byte counts and timestamps.
The observation window is 5–12 November 2026 UTC. Other eligible identities retain
their login checks; refused credentials and unanswered checks suspend attempts.
Google is excluded from automated login checks.

Admin `GET /v1/login-checks?from=2026-11-05T00:00:00Z&to=2026-11-12T00:00:00Z&limit=1000`
returns metadata, oldest first, bounded to the latest matching rows. The end time
is exclusive. Legacy code requests and account payloads are removed from responses.
`readVersion:2` identifies the corrected quiet-navigation validator. Quiet mode
validates the DOM and does not report an invented HTTP status.

Admin `POST /v1/sessions/{id}/login-check {"site":"fold3"}` performs the same
read-only observation on `ancestry`, without consuming the daily job or writing
a login. Read exceptions get up to three fresh-tab attempts on the same browser;
`readAttempts` reports the count. An observed sign-in prompt is returned immediately. Admin `GET /v1/sessions/{id}/diagnostics` reports Chrome process-group
RSS and process counts without command arguments.

Admin `POST /v1/sessions/{id}/fault/chrome-kill {}` sends SIGKILL to that session's
quiet Chrome. Use an idempotency key. It ends the session, cleans its process group
and returns remaining process/zombie counts. The named profile stays on the volume.

Unprotected noVNC views require API authentication. Protected identities refuse
both the HTML view and the VNC WebSocket with 403; screenshot and CDP image methods
are also refused. Requesting human help still requires the owner's agreement.

The finite viewer check runs with `mosaic/stealth_check.py fold3-soak OUTPUT_DIR`.
It samples RSS and exit IP every five minutes for three hours, checks an
authenticated search and advances the viewer through native input. It renews
after the 175-minute sample and restarts earlier if the exit IP changes.
`--resume` continues only the recorded live `ancestry` session, preserving the
original time and sample numbers. Run the local sampler detached when it must
survive chat interruptions. Keep its metadata path and PID in Mosaic's
infrastructure register until it releases the browser.


## Phase 6 interface and caller observations

`bb.py` and `toolstack.py` are the shared Python client; no parallel `remote.py` is
needed. Use `Browser(site="bizapedia", caller="companies_fetch.py")` for interaction
or `fetch_page(url, site="udn", caller="fetch_news.py")` for one page. The fast path
climbs the measured routing ladder and releases any allocated browser. Callers can
supply a payload validator; an empty search with an explicit zero-results marker
is a successful read.

Site defaults share `/data/routing/routes.json` with learned rungs and measured
traffic policies. `GET /v1/sites` lists them; `GET /v1/sites/{name}` also accepts an
encoded source URL for a dynamic host. Each row holds its identity (null means
throwaway), mode, residential country, starting rung and vault login site.
`PUT /v1/routing/policies/{host}` can update these fields alongside `split` and
`ttlSeconds`. Ancestry, Newspapers.com and Fold3 keep `ancestry` for login and
collection. Explicit mode and residential overrides apply to unprotected sites.

`POST /mcp` serves stateless Streamable HTTP using the same named keys, vault
permissions and session ownership as REST. Send `steel-api-key` or a Bearer token
in a header. A supplied Origin must match the configured service origin. GET and
DELETE return 405; the service provides no standalone SSE stream.

The browser tools are registered as the `browser` toolkit. `tools_search` finds
available tools by keywords; `tools_describe` returns a tool's input schema and
toolkit version. `tools_execute` takes `name`, `arguments` and an optional `version`,
then returns the same result as a direct call. Both execution paths enforce the
existing session and vault permissions.

Set `MCP_TOOL_EXPOSURE=discovery` to list only the discovery tools. The default
`all` also lists the existing tools for client compatibility. See
[toolkits and discovery](TOOLKITS.md) for examples and extension registration.

The `connections` toolkit exposes `connections_list`, `connections_get` and the
admin-only `connections_configure`. Existing accounts have stable IDs such as
`browser:ancestry`; pass one as `connection` to `browser_open` or
`POST /v1/sessions`. REST account metadata is available at `/v1/connections`.
Saved profiles and recorded login outcomes are reported separately; listing
accounts does not verify a live login. Explicit profile grants apply to new
sessions opened through connection IDs or raw identities.

| Tool | Operation |
| --- | --- |
| `browser_sessions` | List your live sessions for resuming work or cleanup |
| `browser_open` | Open by site or URL and return a compact snapshot with the page and continuation token; optional identity, mode and residential override |
| `browser_snapshot` | Stable element refs, with tab selection, interactive/compact filtering and depth |
| `browser_act` | The full [command request](COMMANDS.md#request), including tabs, locators, drag/upload, eval and status/cancel/dialog controls |
| `browser_read` | Pageable markdown, visible text or masked HTML, with optional target and frame |
| `browser_screenshot` | PNG, JPEG or WebP, with agent-mode full-page and element capture; protected identities refuse images |
| `browser_download` | Fetch a URL or click a reference and return a session-scoped files link |
| `browser_login` | Run the configured vault flow; verification codes belong to its waiting login |
| `browser_handoff` | Require the owner's explicit agreement before returning an authenticated view |
| `browser_network` | Agent-mode request metadata, omitting headers, bodies and query strings |
| `browser_close` | Release and report settled bytes and estimated residential cost |
| `fetch` | Read one page as markdown and close its browser |

Reuse the session returned by `browser_open`. When its execution completes, its
`observe` field contains the initial snapshot; send `observe:{"mode":"none"}` to
skip it. Batch related actions and request the changed outline in the same call:

```json
{
  "session": "SESSION_UUID",
  "after": "NEXT_FROM_PREVIOUS_RESPONSE",
  "idempotencyKey": "UNIQUE_ACTION_KEY",
  "commands": [
    { "command": "fill", "target": { "label": "Search" }, "value": "Echo Flight" },
    { "command": "press", "target": { "label": "Search" }, "key": "Enter" }
  ],
  "observe": { "mode": "diff", "compact": true },
  "eventsAfter": "c-0"
}
```

`browser_act` uses the REST command schema directly. It accepts one command or a
list of up to 50, plus `after`, `observe` and `eventsAfter`. Reuse an
`idempotencyKey` for a transport retry; choose a new key for new work. The HTTP
`Idempotency-Key` header remains supported. Pass each response's `next` as the
next request's `after`, and advance `eventsAfter` to `events.cursor`.
`browser_open` also accepts `idempotencyKey`; reuse it on retry to recover the
same session. `browser_download` accepts it to avoid repeating a reference click.

Each command-based tool uses one engine exchange with its normal 20-second
response window. Opening a browser and downloading by reference follow this
same rule, with no additional polling loop in MCP.
A `queued` or `running` execution continues on the service. Send
`{"command":"status","execution":"x-…"}` or `cancel` alone through `browser_act`.
Answer a pending dialog with its `dialog` command. These controls run outside
the execution queue. A successful cancellation returns a normal tool response,
with the original execution's effects and cancelled results. Unfinished work
records an unknown caller outcome.

Failed batches return `isError:true` and preserve the command envelope, including
partial results and each action's effect. Inspect those results before retrying.
An observation failure preserves the completed actions. Request errors retain
their error code and recovery fields, including `next` or `retryAfter` when supplied.
If the initial navigation or observation fails, `browser_open` returns the
session with the error so you can recover or release it.

`browser_read` returns at most 20,000 characters by default. Set `limit` (up to
100,000) and use a result's `nextOffset` as the next `offset`, keeping its format
and target. Offsets and limits count Unicode code points, so a page boundary
preserves emoji and other characters outside the basic multilingual plane.
`total` counts the full masked text. Reads use the current document;
if the page changes, begin again. REST `get text/html/markdown` accepts the same
optional paging fields and retains its full-output default.

MCP snapshots, including action observations, use the same 20,000-code-point
default. Continue an outline through `browser_snapshot` with its `snapshotId`
and `offset: nextOffset`; this reads the retained outline. Diff observations
return the smaller complete response, and fall back to the paged outline when
either outline is partial.

MCP `fetch` also accepts `offset` and `limit`. Continue with its returned
`requestId` and `offset: nextOffset`, keeping the other arguments unchanged.
This reuses the existing request cache for up to ten minutes while the entry
remains retained. After expiry or eviction, begin the read again.

Screenshots use native MCP image content. Printed PDFs and completed browser
downloads return a `delivery` object containing the transfer ID and checksum.
A pending reference click returns its engine execution for `browser_act` status
or cancellation. A URL preparation returns a delivery ID; poll it with
`browser_download` using `transfer`, or set `cancel:true` to discard it.
Protected identities refuse screen and print capture.

For normal use, add the hosted `/mcp` URL to an OAuth-capable agent and
approve its connection through `/connect`. No local runtime is required. The
gateway publishes OAuth discovery and dynamic registration; clients keep
rotating refresh tokens. Account access uses the existing invitation or access
key. Manage connected apps at `/account`; direct API keys remain an advanced
option. See [team connection](TEAM.md#teammate-connection).

A ready file includes `webUri`. Open it in a signed-in browser and click
**Download**, or use **Downloads** in the dashboard. The browser uses its normal
save location and controls. It does not send a claim that the OS durably saved
the file; the server removes its copy at expiry or when explicitly removed.
Ready MCP handoffs remain available until thirty minutes after publication,
so the agent can release the remote browser before the user saves the file.
Temporary links can become unavailable earlier if the worker restarts.

Scripts needing automatic, checksum-verified local publication can use the
[optional automation client](client/README.md):

```sh
toolstack receive --session SESSION_ID --transfer DELIVERY_ID
```

Its local stdio bridge adds `browser_save`. Both paths stream and verify size
and SHA-256, then publish atomically before acknowledging deletion. Existing
files are preserved; matching retries reuse the saved bytes. Normal failure
removes staging data, and the next receive removes dead-owner crash remnants.
Hosted connections and ordinary downloads use the service and browser directly.

Mosaic's `bb.py --download DIR` and `toolstack.py --receive-download` adapt to the
automation receiver while retaining their INBOX default and legacy-server
behavior. Byte-returning `download()` and `fetch_bytes()` still allocate their
requested bytes in memory and leave local persistence to their caller.

After the owner agrees to a particular handoff, an administrator may record that
agreement with `POST /v1/sessions/{id}/handoff-approval` and
`{"ownerAgreed":true,"reason":"the agreed reason"}`. The returned token lasts five
minutes, is bound to the session/reason/owner, and can be used once.

Named keys cannot issue approvals. Protected identities refuse approvals and
views. No tool asks a person for help automatically.

Session creation accepts a `caller` tag. Admin-only
`GET /v1/caller-outcomes?from=...&to=...` returns metadata by caller and UTC day,
including session end reasons, settled bytes and caller results.

Results survive restarts on `/data/routing/caller-outcomes.jsonl`. The summary
contains no page content, URLs or credential values. The end time is exclusive.

Each Python `Browser` context is one measured caller run; each `fetch_page` is one
read. Successful transport alone does not establish payload success.

Callers report validated results with `outcome(True)`, failed access with
`outcome(False, reason)`, or an unverified empty response with `outcome(None)`.
A failed validation remains failed if later reads succeed in the same context.
`unknown` results prevent acceptance.

MCP rows count tool operations separately. `failedOrFallback` counts the union,
so a failed fallback is counted once; divide it by `attempts`.

Python queues unacknowledged metadata in `Mosaic/.state/browser-outcomes.jsonl`
and retries it at the next result, preserving the original observation time.
Clear that queue through successful sync before judging a window:

```bash
.venv/bin/python scripts/browser/toolstack.py --flush-outcomes
.venv/bin/python scripts/browser/toolstack.py --outcomes --from 2026-11-05T00:00:00Z --to 2026-11-13T00:00:00Z
```

The exact UTC windows and unresolved source blocks are in
[mosaic/CALLERS.md](mosaic/CALLERS.md). Evaluation requirements are maintained in
[the plan](TOOLSTACK-PLAN.md#caller-review-and-browserbase-retirement).
Ancestry general search and Utah failures remain counted after their parser fixes.
Utah's explicit empty-search heading and suggestion list are valid even when
the result table is absent; the real caller verified this on `4bf8e12`.
PICRYL and Legacy use measured quiet US host policies with throwaway profiles;
these policies do not change other hosts or protected logins.

The before-change inventory and current results are in
[mosaic/CALLERS.md](mosaic/CALLERS.md).

Toolstack caller cleanup releases the shared browser before waiting for the local CDP
driver to stop. The serial checks exposed a stalled driver after SIGINT; this order
keeps that local cleanup from holding a pool slot.

Fetch requests accept `timeoutMs` (1,000–300,000; default 180,000) and a UUID
`requestId`. One deadline covers the entire routing ladder. A stopped request
returns HTTP 408 with `fetch_timeout` or `fetch_cancelled`; its ID cannot start a
new job for ten minutes, including when a failed idempotent request is retried.

`POST /v1/fetch/{requestId}/cancel {}` cancels only that agent's request. Unknown
IDs return `not_running` and prevent a late request with the same ID from starting.
Cancellation releases the job's browsers; a launch already pending releases as
soon as it resolves and cannot advance to another route.

The Python fast path supplies a stable request ID and a total caller budget
(default 300 seconds). Its HTTP worker bounds a full exchange, and it explicitly
cancels unfinished service work before fallback or interruption cleanup.
Browserbase setup, connection and navigation use the remaining budget; remote
release receives a short cleanup allowance after expiry.
