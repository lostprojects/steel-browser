# Using the service

The service runs Google Chrome 156.0.8078.79 with three independent browser sessions.
Browserbase is Mosaic's temporary fallback until phase 6 moves the callers.

## Sessions and identities

Send `steel-api-key` on HTTP requests. Use `STEEL_API_KEY` for administration;
named client keys have separate daily residential budgets of 1 GB (1,000,000,000
bytes). The day changes at midnight UTC. Direct traffic does not use that budget.

Create a direct session with `POST /v1/sessions {"mode":"agent"}`. For a managed
residential exit, send `{"mode":"quiet","residential":{"country":"US"}}`.
The service allocates a Core sticky exit, looks up its IP and timezone through
that exit with ipwho.is, then starts Chrome with the returned timezone.

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

A fourth session waits up to five seconds, then gets HTTP 429. Mosaic currently
uses Browserbase after that response. Three simultaneous Mosaic callers and the
fourth-caller fallback passed before the service update, using zero residential bytes.

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

`POST /v1/sessions/{id}/download {"url":"https://..."}` fetches from Railway with
the browser's cookies and User-Agent. It retries through the session's exit when
direct fetching fails. Cookies retain their domain/path/secure rules across redirects.
The response contains base64 bytes, headers and the route used; one transfer is
limited to 64 MB. Larger files need a later streaming interface.

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

An administrator imports values with `PUT /v1/vault/{name}` using `fields` and `allowedAgents`. `GET /v1/vault` and `GET /v1/vault/{name}` return names, field names and last-use times. `mosaic/vault_import.py` transfers the selected project env fields through that API without printing values.

Create a quiet session with identity `ancestry` or `mary-ferrell`, then call `POST /v1/sessions/{id}/login {"site":"ancestry"}`. The Ancestry identity also accepts sites `newspapers` and `fold3`. The service validates account content, types through X11 and records `last_login_ok`. `current:true` checks the present page and signs in again when it observes signed-out controls. An unrecognized page returns `unchecked`; it does not establish authentication.

Protected identities require access to their vault entry and use a fixed sticky residential allocation throughout. `/request` sends authenticated GET or POST requests over that same exit. Signed CDN downloads can try direct egress. Protected profile exports and image capture are refused because they can expose login details; text responses and CDP replies are scrubbed.

Two-step outcomes remain explicit. Stored authenticator seeds generate TOTP codes at use. Email and SMS code fields issue a local code request; other device checks retain their classification. HathiTrust Google values are stored, but its flow returns `not_attempted` / `google_flow_unimplemented`. No Google challenge has been observed. The service does not request a manual login.

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

This adds no mailbox watcher and gives Railway no access to local message history. The daily service check records an unanswered challenge when no local caller is present. Google’s login flow remains unimplemented; a code bridge does not complete that flow.
