# Private team browsers

The current team-mode implementation gives each person in one organization a
separate Toolstack service and volume. One HTTPS gateway connects their agents
to that service; an owner-managed shared store supplies credentials and site defaults.

The running deployment has one organization and its owner. The gateway store,
signed principals and workers are bound to that organization's UUID. Existing
`global` identifiers mean organization-wide sharing. The
[organization contract](ORGANIZATIONS.md) records the current controls and the
additional isolation required before admitting unrelated organizations.

Product direction and deployment acceptance are maintained in
[TOOLSTACK-PLAN.md](TOOLSTACK-PLAN.md#1-accept-the-hosted-foundation).

Toolstack history belongs to the user for every session, including sessions using a shared login. Credential sharing does not change who can access a user's browser activity or saved history.

Use a dedicated runtime for every user. Multiple worker processes on one host, a shared `/data` mount, or extra `STEEL_AGENT_KEYS` on one service do not establish this boundary. Chrome has powerful debugging interfaces; profiles and API filters alone cannot protect unrelated users on the same runtime.

## What stays private

| Data | Location and access |
| --- | --- |
| Browser profiles, cookies and local storage | The user's worker volume |
| Active sessions, live views and event streams | The user's worker process |
| Downloads, session history and login observations | The user's worker files and memory |
| Personal credentials | The user's AES-256-GCM vault |
| Owned skill instructions, versions and sharing | Dedicated central Toolstack Postgres; permission checked on every read |
| Supporting scripts and reference files | Private Wasabi objects, encrypted by the central library |
| Membership and worker connection secrets | The gateway's separate encrypted volume |
| Shared credentials and site defaults | The gateway's global store; only its owner key can write |

The gateway selects a worker from the authenticated key. Session IDs and user headers cannot select another worker. The owner key routes browser requests only to the `owner` worker; there is no API to impersonate a claimed user or issue keys for them.

Every login opens within the authenticated user's worker and private browser profile. Toolstack has no shared-history mode. The hosting operator retains administrative access to machines and volumes.

## Membership and future administration

Bind each private worker and its volume to one organization membership. A person
in several organizations gets separate workers and account bindings. Sharing a
skill or credential grants access only within the selected organization and
leaves the recipient's activity private.

Organization owners and admins manage membership and organization-owned resources.
Those roles provide no member impersonation, private-vault access or private
browser viewing. Billing permission has no content-access authority. A selected
personal package can be copied into organization ownership without exposing its
private versions; organization-owned assets survive their maintainer's departure.

Invitations and OAuth app approvals must name the organization and bind to its
membership. Suspending one membership must not disable the person's unrelated
memberships or revive old grants on reinvitation. These are planned requirements;
the commands below still address the existing single-org model.

## Teammate connection

1. Give the teammate their invitation through a private channel. It expires after 24 hours and can be accepted once. The invitation uses a URL fragment, which is removed by the connection page before acceptance.
2. They accept it in a browser and keep their access key in a password manager for future account sign-in. The key appears once; the gateway persists its SHA-256 hash.
3. They copy the connection address from `/connect` into their agent's remote MCP connections and approve the app in the browser. OAuth-capable MCP apps need no local installer or copied account key. Connected apps can be disconnected at `/account`.

The gateway publishes OAuth discovery, dynamic client registration and an
authorization-code flow with S256 PKCE. Access tokens last fifteen minutes;
rotating refresh tokens expire after thirty days without use. App connections
persist in the encrypted gateway store across restarts. Each is limited to its
user's permitted tools, accounts and private files, with no gateway
account-management permission. The legacy OAuth scope identifier remains
`browser` for client compatibility; the approval page describes the capability
access it authorizes.

For clients that need direct API credentials, advanced key access remains at
`/account`. REST uses `Authorization: Bearer <key>` or `steel-api-key`; MCP uses
the same headers at `/mcp`, and CDP uses the session's `websocketUrl`.

All of a person's agent keys access that person's worker. These keys are bearer credentials, so store them in the agent's secret configuration. The gateway refuses credentials in query strings.

Each worker has its own HTTP admission budget. Its agents share spare CPU and
memory capacity, with a short bounded queue for bursts. Browser sessions use
their separate `MAX_SESSIONS` limit. See [resource budgets](DEPLOYMENT.md#railway-configuration)
for automatic sizing and operator overrides.

Normal downloads use the browser's download controls, either through the file's
`webUri` or **Downloads** in the dashboard. Prepared handoffs remain available
after their browser session closes, until their thirty-minute expiry. The
browser does not claim a checksum-verified local receipt; expiry removes the
server's copy. Only specialized automation needs the [local client](client/README.md).

Mosaic's Python client uses the same receiver for local publication and retains its temporary Browserbase fallback.

The dashboard uses a Secure, HttpOnly, SameSite=Strict cookie with a 12-hour
lifetime. Sign in at `/connect`; browser sign-ins expire when the gateway
restarts. An app's OAuth connection is independent of that cookie. Revoking its
connection, its originating account key, or suspending its user stops its
access. Key revocation and suspension close active proxied connections,
including WebSockets and SSE.

## Provisioning

These commands provision private workers within the configured organization.
Set `TOOLSTACK_ORG_ID` to its existing UUID and `TOOLSTACK_ORG_NAME` to its display
name before running them. The provisioner refuses an absent or invalid UUID.
Future organizations require their own data service and storage credentials.

Use one gateway replica with its own `/data` volume and one separate service and volume per person. The existing Toolstack service and its volume can become the `owner` worker. Preserve its current `VAULT_KEY`, named profiles and proxy settings.

All services use the root Dockerfile. Set `STEEL_IMAGE=gateway` in the gateway service's Railway variables so its build selects the small gateway image; keep `STEEL_ROLE=gateway` in its runtime configuration. The image contains the gateway entry point and the MCP SDK’s OAuth runtime, with no Chrome, display tools or Python. Browser workers use the default `STEEL_IMAGE=browser` and `api/build/start.js`.

For a local image build, run `docker build --platform linux/amd64 --build-arg STEEL_IMAGE=gateway -t toolstack-gateway .`. The gateway image starts `gateway/start.js`; leave its start command unset in Railway. New user workers receive fresh API, vault and shared-reader keys; do not give them the gateway encryption key or another worker's variables.

The local administration tool writes secrets to files with mode `0600`. Store those files outside the repository in private operator storage. It refuses to overwrite an existing file.

```sh
npm run team -w repl -- init https://TEAM_GATEWAY PRIVATE_DIRECTORY
npm run team -w repl -- worker alice https://TEAM_GATEWAY \
  http://toolstack-alice.railway.internal:3000 PRIVATE_DIRECTORY
```

The first command writes `gateway.env`. The second writes `alice.worker.env` and `alice.register.json`. Deploy the gateway variables and worker variables to their respective services, then configure the worker's residential proxy if needed.

Owner migration also requires `STEEL_EXISTING_MAX_SESSIONS`, alongside the
existing vault and worker keys. Read the actual service configuration first.
The current owner worker reports twelve sessions; migration refuses an omitted
capacity rather than writing the new-worker default of three.

Railway's internal service connections use encrypted WireGuard networking; the gateway accepts worker origins under `*.railway.internal` over HTTP, or HTTPS origins. Use the real service DNS name and port. See [Railway private networking](https://docs.railway.com/networking/private-networking).

| Gateway variable | Purpose |
| --- | --- |
| `TOOLSTACK_ORG_ID`, `TOOLSTACK_ORG_NAME` | Existing organization UUID and display name; also required on workers |
| `STEEL_ROLE=gateway` | Start the gateway only |
| `STEEL_PUBLIC_ORIGIN` | Canonical HTTPS origin |
| `STEEL_API_KEY` | Independent owner control key, at least 32 characters |
| `GATEWAY_STORE_KEY` | 32 random bytes encoded as 64 hex characters |
| `GATEWAY_STORE_PATH` | Default `/data/gateway.enc` |

| Worker variable | Purpose |
| --- | --- |
| `STEEL_ROLE=worker` | Start a private browser service |
| `STEEL_USER_ID` | Stable registered user ID; `owner` for the existing service |
| `STEEL_API_KEY` | Unique worker key; the gateway uses it upstream |
| `VAULT_KEY` | Unique personal vault encryption key |
| `STEEL_SHARED_URL` | The gateway's canonical HTTPS origin |
| `STEEL_SHARED_KEY` | Unique read-only shared-store credential |
| `DOMAIN`, `USE_SSL=true` | Gateway host and HTTPS, for generated browser URLs |
| `PROFILES_ROOT`, `VAULT_PATH` | `/data/profiles` and `/data/vault` on that user's volume |
| `HOST=::`, `PORT=3000` | Listen for Railway's private network and service traffic |

For the owner's existing volume, run the `worker owner … --migrate-owner` command with its existing secrets supplied through `STEEL_EXISTING_WORKER_KEY` and `STEEL_EXISTING_VAULT_KEY`. It retains those secrets in the generated configuration. Preserve the live owner's capacity setting and existing named keys separately; the new-worker template defaults to three sessions.

Set the administration tool's `STEEL_URL` and `STEEL_API_KEY` to the gateway origin and owner key. Register each deployed worker:

```sh
npm run team -w repl -- register PRIVATE_DIRECTORY/alice.register.json \
  PRIVATE_DIRECTORY/alice.invitation.txt
npm run team -w repl -- users
```

Registration verifies the worker's fixed user ID and gateway settings before issuing an invitation. A user ID, worker URL or worker credential cannot be reused. The worker preserves its `.steel-user` marker and adds `.toolstack-organization` and `.toolstack-membership` markers beside its profile directory. It refuses a volume bound to another organization or membership.

Keep worker domains private where possible. Workers' public health checks reveal only readiness. `/v1/worker` requires the worker key and is blocked at the gateway. Keep Railway project and volume access restricted to the hosting operator.

## Owned content

The gateway hosts the [Library](LIBRARY.md) using dedicated Postgres and Wasabi
configuration. Private workers receive only their shared-reader key and call the
gateway for content. The gateway derives ownership from that key and verifies
connected-app claims against its current membership. A worker cannot select a
different person through a request body.

Package sharing and account sharing have independent controls. Private packages
apply to their owner; publication or explicit assignment grants access to the
current instructions and files. Personal vault credentials stay on private
volumes. Move central library configuration from a standalone owner service to
the gateway when converting that service to a private worker. Keep the content
encryption key and database unchanged during that move.

## Personal and global stores

Here `global` names the existing shared store within this one organization.
It must never become a platform-wide store of customer credentials. The
encrypted store binds historical entries and grants to the configured organization
on its version-1 migration. Internal reads require a matching organization header;
signed claims with missing organization or membership fields are refused.

`PUT /v1/vault/NAME` on the gateway writes to the authenticated person's private worker. Supply `{"fields":{"username":"…","password":"…"}}`; `allowedAgents` defaults to the worker's gateway identity. `DELETE /v1/vault/NAME` removes that private override.

`GET /v1/vault` returns metadata with `scope: personal` or `scope: global`. Secret values are used by the existing login flows, which remain available for Ancestry, Newspapers.com, Fold3, Mary Ferrell and HathiTrust Google. Other sites can retain a manual login in a private named profile.

The owner publishes shared entries with these commands. The credential JSON is a field map, such as `{"username":"…","password":"…"}`. Supply secrets through private files, without putting them in command arguments.

```sh
npm run team -w repl -- shared-vault mary-ferrell PRIVATE_FIELDS_JSON
npm run team -w repl -- shared-grants mary-ferrell owner alice
npm run team -w repl -- shared-site www.example.org PRIVATE_SITE_JSON
```

A site JSON contains `site` and an HTTPS `url`. Optional fields are `identity`, `mode`, `country`, `loginSite` and `startRung`. The hostname must match the command's host. These are published defaults, so exclude personal URLs or account identifiers.

| Endpoint | Permission |
| --- | --- |
| `GET /v1/global` | Any authenticated user; shared names/field names and site defaults |
| `PUT /v1/global/vault/NAME` | Owner only; field map body |
| `PUT /v1/global/vault/NAME/grants` | Owner only; `{"allowedUsers":["owner","alice"]}` |
| `PUT /v1/global/sites/HOST` | Owner only; site definition body |
| `DELETE /v1/global/{vault,sites}/NAME` | Owner only |
| `GET /internal/shared` | Dedicated worker reader key only; no personal data |
| `POST /internal/principal` | Assigned worker reader key only; recheck its person's connected key |

New shared credentials default to the owner. Grant named registered users before
they can discover or receive an entry. Filtering happens at metadata discovery
and secret supply. Historical entries without a grant retain their company-wide
access; the owner can narrow them explicitly. Updating a credential preserves
its grant, and deleting it removes the grant.

Personal credentials take precedence when a login flow needs credentials. Changing an entry does not sign out an existing browser profile or change the website account already in use. Release the session and remove that identity through `/v1/identities/NAME` before intentionally switching accounts; this deletes its saved browser state.

The [connection catalog](TOOLKITS.md#existing-accounts) discovers accounts within
the authenticated person's worker. Its labels and profile grants stay on that
worker's volume. Explicit grants control new sessions; changing them does not
sign out the website or close existing sessions.

Connection grants retain their worker agent names. Updated gateways also supply
a signed connected-app claim, verified against the assigned worker. Toolkit
policies can inspect `context.agent.connectedApp`; API history records the
key/grant ID without tokens. Existing grants remain compatible. A per-key policy
editor remains future work.

Shared metadata is cached for at most fifteen seconds. Secret use and protected
profile admission fetch current grants and fail closed when the shared service
is unavailable. Personal entries remain available. Website sessions already
issued can remain signed in; provider-side revocation is separate.

Session history and login observations follow the same private storage and access rules for personal and shared credentials. Workers do not upload activity or browser state to the global store.

Shared defaults are applied on read and are not copied into private routing history. Team workers do not run the legacy daily login observation job.

## Access management

`POST /v1/me/keys` with `{"label":"agent name"}` returns a new personal key once. `GET /v1/me/keys` lists that person's key metadata, and `DELETE /v1/me/keys/ID` revokes one. Create a replacement before revoking the last key.

The owner can use `team disable USER_ID` or `team enable USER_ID`. Suspension
disconnects proxied activity and refuses the user's shared reader key. Queued
browser/API operations recheck connected-app authorization before dispatch.
Work that has already acted may have an uncertain external outcome; API history
preserves that state and its reservation. Suspension leaves profiles intact.

`team invite USER_ID OUTPUT_FILE` replaces an invitation only while the user is unclaimed. There is no remote administrator reset for a claimed user's keys. Recovery after losing every key requires an explicit offline recovery procedure with the user's involvement.

Back up the encrypted gateway file with its encryption key stored separately, and preserve every worker's volume and vault key. Changing the gateway encryption key without migrating its file causes startup to fail. Worker connection records are immutable through the public API.

Record the gateway and every private worker in Mosaic's infrastructure registry when activating them. The gateway runs continuously, with bounded request/connection timers; it creates no scheduled job. Its logs exclude request paths and bodies. Railway's own HTTP logs remain visible to the hosting operator.
