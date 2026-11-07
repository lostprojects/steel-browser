# Native search toolkit

Toolstack implements `exa_search`, `exa_contents` and `api_usage` through its
existing MCP registry. Requests go directly to Exa using a permitted entry in the
worker's encrypted vault. API credentials stay server-side.

## Configure an account

Store an Exa key in the existing vault with a field named `apiKey` and grants
for the intended agents. An administrator then calls `connections_configure`:

```json
{
  "id": "api:exa",
  "label": "Exa",
  "allowedAgents": ["mosaic"],
  "api": {
    "provider": "exa",
    "vault": "exa",
    "credentialField": "apiKey",
    "allowedTools": ["exa_search", "exa_contents"],
    "dailyCalls": 100,
    "dailyBudgetUSD": 0.10,
    "enabled": true
  }
}
```

REST uses `PUT /v1/connections/api:exa` with the same body minus `id`.
API configuration replaces the full binding and policy. Omitted grants default
to admin; omitted binding fields use the defaults shown above. Browser profile
configuration retains its existing partial-update behavior.

Both the connection grant and vault grant must permit the agent. Tool permissions
and enabled status are checked on every invocation, including cached retries,
and again when queued work starts. `connections_list` and `connections_get`
return metadata only. Status `configured` means the referenced credential field
is available; it does not establish that Exa accepts the key.

## Call the tools

```json
{"connection":"api:exa","query":"Exa search API documentation","mode":"lite","numResults":5,"idempotencyKey":"search-001"}
```

Pass this to `exa_search`. Modes are `auto` and `lite`, with one to ten results
and optional domain/publication-date filters. Search returns source metadata.
It requests no synthesized answer or fetched page text.

```json
{"connection":"api:exa","urls":["https://exa.ai/docs/reference/search"],"maxCharacters":4000,"idempotencyKey":"contents-001"}
```

Pass this to `exa_contents`. It accepts one to ten distinct HTTP URLs without
embedded credentials and returns source text capped at 100–20,000 characters
per result. Saved browser authentication is not sent to Exa. Per-URL statuses
and truncation flags identify partial results.

Toolkit version `1.1.0` adds acquisition time and per-result source IDs. The
executor records the capability version and credential reference and scope.
A retry with a changed version or personal/shared binding is refused.

Both tools accept `timeoutMs` from 1,000 to 60,000, defaulting to 30,000.
Provider responses are limited to 4 MiB. Result envelopes contain `ok`,
`execution` metadata and normalized `data`. Direct calls and `tools_execute`
use the same validation, permissions and execution identity.

## Usage and retry behavior

Each call reserves usage durably before contacting Exa. Search reserves $0.01;
contents reserves $0.002 per URL for text retrieval. These conservative amounts
are compared against a connection's UTC daily allowance across all its agents.
Successful responses use Exa's reported cost estimate when supplied, otherwise
they retain the reservation. These estimates are not billing invoices or a
provider-enforced hard spending cap.

Authentication, exhausted credits and rate limits have separate public error
codes. No provider request is retried automatically. Reuse `idempotencyKey`
when recovering from a lost response; use a new key for intentional new work.
A changed payload or credential binding with the same key is refused.

The shared operation runner retains up to 64 API responses for five minutes.
After expiry or worker restart, a recorded retry returns
`execution_replay_unavailable` with metadata rather than contacting Exa again.
The durable retry identity lasts seven days; use fresh operation keys after
that period. A request stopped after dispatch is recorded as `unknown` and
keeps its reservation, including when a late response arrives. Failures before
dispatch have zero accounted cost. Dispatched provider refusals also retain
the conservative reservation. Calls count attempted admissions.

`api_usage` accepts `connection`, `limit` and `offset`; REST provides
`GET /v1/connections/ID/usage` with the same pagination. Daily totals cover the
connection; individual execution history is restricted to the caller unless
admin. The journal stores timing, tool/account identifiers and cost metadata.
It excludes query text, URLs supplied for contents, returned bodies and keys.
Retry fingerprints use HMAC with the worker vault key.

History retains seven days, with pruning during subsequent reservations and a
10,000-execution capacity. The worker uses one journal writer; replicas must not
share its volume. Malformed journals fail closed. Keep `VAULT_KEY` and the
journal intact across updates; rotating the key also changes retry fingerprints.

## Verification

Local verification covers account isolation, credential redaction and concurrent
budget admission, plus restart accounting and late-work cancellation. The API
build and the existing routing/login/session-pool tests pass.

The isolated local HTTP pilot passed with real Chrome and Exa. A fresh named
profile preserved its test cookie across closure and reopening. The same named
agent used one MCP endpoint for browser reads, Exa search and contents retrieval.
Two provider calls reported a combined $0.005 estimate; a generic MCP retry reused
the search result and a third call was refused at the configured daily limit.
REST usage reporting and invalid pagination were also verified. The pilot used
no existing owner profiles, and its temporary runtime and encrypted vault were
removed afterward. [The plan](TOOLSTACK-PLAN.md#current-baseline) tracks deployment
acceptance separately from this local result.

Product direction and further work are maintained in
[TOOLSTACK-PLAN.md](TOOLSTACK-PLAN.md#delivery-sequence).

Provider references: [search](https://exa.ai/docs/reference/search),
[contents](https://exa.ai/docs/reference/get-contents) and
[pricing](https://exa.ai/docs/admin/pricing).
