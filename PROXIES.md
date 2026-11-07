# Proxy management

Use the local `evomi` CLI for provider inventory, remaining bandwidth, usage, targeting and credential verification. Its instructions are in [the Evomi skill](/Users/moi/.codex/skills/evomi/SKILL.md). It loads credentials from `/Users/moi/nosync.nosync/-env/global.env`; no credentials belong in this repository.

## Account access and consumption

| Variable in global.env | Purpose |
| --- | --- |
| `EVOMI_EMAIL`, `EVOMI_PW` | Existing dashboard login for account, billing and invoices |
| `EVOMI_PUBLIC_API_KEY` | Personal Public API access for product inventory, balances, usage, targeting and session rotation |
| `EVOMI_RESIDENTIAL_PROXY_URL` | Core Residential proxy consumed by the Toolstack service |
| `EVOMI_PREMIUM_PROXY_URL` | Premium Residential proxy |
| `EVOMI_DATACENTER_PROXY_URL` | Datacenter proxy credentials, independently of remaining balance |
| `EVOMI_MOBILE_PROXY_URL` | Mobile proxy credentials, independently of remaining balance |

The personal API key and the Core/Premium credentials were matched against Evomi's live API on 2026-11-07. This account's proxy resources are personal, so a team key is not required for these configured URLs. The existing key was retrieved from the dashboard without rotation. Mobile and datacenter credentials are also stored, but both products had zero remaining bandwidth at that check. There were no static-residential packages or enabled Evomi browser/scraper credentials to preserve.

Deploy consumption URLs only for products the worker should use. Core is enough for existing `residential` requests. Additional products remain admin-only until an administrator grants a profile. Keep dashboard credentials and the Public API key in the local shared environment: the runtime does not need them. The separate `-env/toolstack.env` contains Toolstack client access.

## Runtime design

`ProxyService` owns each verified route, local forwarding listener, lifetime and byte ledger. Browsers borrow a lease; HTTP and download consumers use that same local listener. `BrowserSession` never constructs its own upstream connection. Profile definitions reference environment variable names; responses and persisted state contain no authenticated proxy URLs.

| Concept | Purpose |
| --- | --- |
| Profile | Product, protocol, targeting, session mode, permissions, TTL, byte cap and explicit fallback order |
| Lease | One actor's metered route with a verified exit, expiration and immutable allocation ID |
| Identity | An exclusive persistent route associated with saved browser state |
| Outcome | Explicit host feedback; blocked exits are quarantined for that profile and host for one hour |

The built-ins are `core`, `premium`, `mobile` and `datacenter`. Core permits all authenticated callers. The others require actual administrator privileges by default. Connected apps have separate ledger and retry identities derived from organization, membership and key; a worker transport key does not make its connected app an administrator.

New built-in routes use `locked` sessions. Evomi fails requests when the bound peer disappears instead of replacing its IP. Profiles can explicitly select `hard` (best effort longevity), `sticky` (optional lifetime) or `rotating` (different exits per connection). Rotating leases are for standalone HTTP work and cannot attach to a browser or named identity. A rotating lease's `exit` describes its allocation probe, not every subsequent request. Custom profiles must point to an authenticated `TOOLSTACK_PROXY_*` environment variable, with the matching protocol; the custom provider controls its own persistence.

Evomi profiles support country and the product's applicable region/city/ZIP/ASN/ISP filters. Premium adds speed/quality pools, device, latency, fraud score, minimum connection time and extended pool settings. Unsupported combinations fail before traffic. The upstream protocol can be HTTP, SOCKS5 or HTTPS where the product supports it; the browser always connects to a private local HTTP listener. These interfaces carry HTTP traffic and HTTP CONNECT tunnels, not general SOCKS or UDP servers. Use `evomi targeting` to obtain provider identifiers. `configured:true` means the environment reference exists; allocation still checks whether it works.

Local end-to-end checks on 2026-11-07 passed Core HTTP, Core SOCKS5 and Premium HTTP using the real Python helper, including a second request on the same locked exit. The documented Premium HTTPS endpoint completed certificate verification but timed out on proxy requests; HTTPS forwarding is implemented but this account/network path remains unverified. Mobile and datacenter traffic were not exercised against unfunded balances. These checks do not validate a deployed worker.

Named allocations verify country, IP and timezone before browser startup. A remembered exit mismatch fails; it does not silently adopt a replacement. Route configuration changes also conflict with the identity's saved binding. Named identities never use fallback. Protected login identities retain their managed Core US route and cannot be allocated as standalone leases. Browser profile permissions apply to other named allocations.

Anonymous allocations can try up to two exits per explicitly approved profile, within one 30-second allocation deadline. Probe bytes consume the same actor and request budget, including failed attempts. Fallback is disabled by default and cannot bypass profile permissions. A caller cannot silently escalate to an otherwise restricted product.

## Using leases

Discover the `proxies` toolkit with `tools_search`, or call its tools directly when full exposure is enabled. `tools_describe` returns the exact versioned schema. The runtime also publishes REST input schemas under the Proxies group at `/documentation/`.

| Native tool | REST route, after `/v1` |
| --- | --- |
| `proxy_profiles` | `GET /proxies/profiles` |
| `proxy_profile_put`, `proxy_profile_delete` | `PUT`, `DELETE /proxies/profiles/{name}`; admin |
| `proxy_allocate`, `proxy_leases` | `POST`, `GET /proxies/leases` |
| `proxy_get` | `GET /proxies/leases/{id}` |
| `proxy_fetch` | `POST /proxies/leases/{id}/fetch` |
| `proxy_release`, `proxy_renew` | `POST /proxies/leases/{id}/release`, `/renew` |
| `proxy_outcome` | `POST /proxies/leases/{id}/outcome` |
| `proxy_usage`, `proxy_health` | `GET /proxies/usage`, `/health`; health is admin-only |
| `proxy_identity_rotate` | `POST /proxies/identities/{name}/rotate`; admin, `{"confirm":true}` |

For example, an administrator can create a Premium profile without supplying credentials in the request:

```json
{
  "product": "premium",
  "session": "locked",
  "protocol": "http",
  "target": {"country": "US"},
  "pool": "quality",
  "allowedAgents": ["mosaic"],
  "allowedCountries": ["US"],
  "budgetBytes": 20000000,
  "ttlSeconds": 1800
}
```

Send that body to `PUT /v1/proxies/profiles/research`. Profile writes replace the entire definition and apply schema defaults to omitted settings; select session and permissions deliberately. `budgetBytes` caps each lease, not the sum of all leases on that profile. The actor's daily allowance is shared across its leases.

Allocate with `POST /v1/proxies/leases`:

```json
{"profile":"research","host":"example.com","budgetBytes":5000000,"ttlSeconds":600}
```

Use the returned UUID in `POST /v1/proxies/leases/{id}/fetch` with `{"url":"https://example.com","maxBytes":1000000}`. Responses contain HTTP metadata and a base64 body. GET and POST are supported with a limited header set; response size, timeout and memory admission are bounded. The call shares the proxy exit and byte ledger, but not browser cookies.

To reuse this route in Chrome, send `{"proxyLeaseId":"<uuid>","mode":"agent"}` to `POST /v1/sessions`, or pass `proxyLeaseId` to `browser_open` alongside its normal URL/site/connection. A lease supports at most one attached browser. Pass its identity too when it has one. The attach must not race an active HTTP request. HTTP requests can run after attachment. Closing the browser detaches an explicitly supplied lease; release that lease separately when finished. An automatically allocated browser lease closes with its browser.

For ordinary browser work, `{"proxyProfile":"research"}` allocates automatically. Existing `residential:{"country":"US"}` requests select Core. Per-action `proxyUrl` overrides have been removed; quick actions inherit the browser route. Admin-only session-level raw `proxyUrl` remains a compatibility input, allocated and metered through the same service; profiles with environment references are the reusable path. The service derives timezone from its verified exit.

Use the same `Idempotency-Key` header on REST transport retries, or `idempotencyKey` on native tools. Keys use 1–128 letters, digits, underscores or hyphens. Changed arguments with an existing key return 409. Retry records are worker memory, retained for ten minutes: after a worker restart, inspect leases before reissuing work. Never assume idempotency survives a restart.

Renew only an active lease with `{"ttlSeconds":600}` within the current profile's TTL. Renewal does not reset its budget. Expiry, exhausted budgets, revoked profile permissions or a changed route definition stop forwarding and close attached browsers through pool cleanup. MCP cancellation aborts lease HTTP work and allocation probes. Standalone HTTP requests are also aborted on release and shutdown.

## Accounting and persistence

The ledger remains at `/data/routing/proxy-state.json`, written atomically with mode 600. Legacy days, total spend, sticky IDs and quarantines migrate in place to version 2. Migration preserves legacy hard-session routing; an idle, explicit `proxy_identity_rotate` abandons its old exit and lets the next allocation use the profile's current session mode. Browser cookies remain. Invalid files and mismatched organizations stop startup rather than resetting allowances. Back up the file before deploying; older images cannot safely write version 2.

A restart closes orphaned lease records. It retains identity bindings and observed usage; it does not recreate a browser or a forwarding listener. Current daily totals use UTC, with 90 daily buckets, lifetime actor/product totals and the newest 1,000 closed lease records. There can be at most 64 live leases per worker and 16 per actor. TTL defaults to three hours and is configurable up to one day.

Byte counters include probe traffic, active tunnels and final connection totals exactly once. Selected direct traffic is tracked separately. The forwarder checks policy on admission and every 50 ms for existing tunnels; pool cleanup runs every second. Concurrent transfers and socket buffers can overshoot a byte cap. Abrupt process termination can lose the current unflushed interval. These are operational limits on observed bytes, not a prepaid reservation or an exact provider invoice. The ledger belongs to one worker; it does not enforce an organization-wide allowance across workers. No fixed dollar-per-GB estimate is emitted.

Host outcomes are explicit client reports, not proof that a site blocks an entire provider. Rate limits do not rotate an identity. Quarantine affects new allocations for the specified profile/host; it does not swap an active route. Private literal IPs and local metadata hostnames are refused at the forwarder. This is not a complete DNS-rebinding or browser-network sandbox.

The runtime uses consumption credentials only. Account balances, invoices, purchases, credential synchronization, scraping/crawling jobs and browser-profile administration remain available through the separate Evomi management tooling below. Static residential gateways can be used as custom profiles when configured and funded.

## Operations

```sh
evomi whoami
evomi balance
evomi usage --product rpc --period 7d
evomi credentials verify
evomi targeting --product rpc --field countries --search United
```

`whoami` verifies Public API access and reports personal/team scope. `credentials status` only checks local presence. `credentials verify` compares the gateway credentials with the API and reports whether Toolstack's Core URL matches. All output masks passwords, API keys and authenticated proxy URLs.

To retrieve currently available consumption credentials into the shared environment:

```sh
evomi credentials sync
evomi credentials sync --commit
```

The first command previews variable names only. The second adds missing values locally with mode 600 and preserves unrelated entries. It refuses a differing existing credential unless `--replace` is explicitly selected after confirming the intended account. This does not reset remote credentials or update a deployment.

One small proxy authentication check can be run directly from this machine:

```sh
evomi check rpc --country US
evomi check rpc --country US --execute
```

The first command is a preview. The executed check requests only `https://ip.evomi.com/s`, uses a small amount of bandwidth, and reports an exit IP without displaying its proxy credentials. It verifies local provider access, not the deployed worker's configuration.

## Usage and sticky sessions

Evomi's API reports decimal MB: divide by 1,000 for GB. The supported windows are `24h` (hourly buckets), `3d` and `7d` (daily buckets). Add `--details` to include request and domain statistics. This is usage for the whole selected account/product. Use Toolstack's own ledger for agent attribution and daily budgets; do not present provider totals as Toolstack-only usage.

Toolstack owns sticky IDs for named identities. `evomi rotate SESSION --product rpc` previews a provider-side rotation; `--commit` performs it. Rotation replaces the existing exit and may interrupt active connections. Do not rotate an identity as a routine diagnostic. The raw `/public/rotate_session` API route has the same guard even though Evomi implements it with GET.

Proxy-data and service-plan purchases, auto-recharge, team membership, invoice export and key/password rotation use the dashboard. `evomi dashboard` returns its verified navigation URLs.

## Broader Evomi operations

The CLI also exposes all 40 tools from official `evomi-mcp` 1.3.1: targeted connection building, proxy pool generation, scraping/crawling/search, saved configurations, extraction schemas, storage, schedules, async tasks and browser profiles. Run `evomi tools` for the inventory and `evomi tools TOOL_NAME` for an exact input schema. The [capability guide](/Users/moi/.codex/skills/evomi/references/capabilities.md) covers aliases and account-access requirements.

```sh
evomi tools build_proxy_connection_string
evomi proxy --data '{"product":"rpc","countries":["US"],"session":"hard"}'
evomi configs list
evomi schedules list
```

Console and report output stays masked. Add `--secret-out NEW_FILE` under `-env` when an application needs actual generated connections or another private result. Changes preview until `--commit`; paid workloads and recurring jobs require `--execute`, with both flags when applicable. These capabilities do not activate Evomi browser/scraper subscriptions or change Toolstack's deployed browser, proxy route or schedules.

## Sources

- [Evomi authentication and personal/team scope](https://docs.evomi.com/public-api/authentication/)
- [Product credentials and balances](https://docs.evomi.com/public-api/endpoints/default/)
- [Bandwidth usage and units](https://docs.evomi.com/public-api/endpoints/bandwidth-usage/)
- [Session rotation](https://docs.evomi.com/public-api/endpoints/rotate_session/)
- [Locked, hard and sticky sessions](https://docs.evomi.com/proxy-instructions/residential-proxies/proxy-sessions/)
- [Proxy protocols and TLS hostnames](https://docs.evomi.com/proxy-instructions/proxy-protocols/)
- [Premium proxy pools](https://docs.evomi.com/proxy-instructions/residential-proxies/modes/)
- [Official Evomi tool catalog](https://github.com/evomi/evomi-mcp)
