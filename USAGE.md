# Using the service

## A session from start to finish

```python
proxy = sticky(EVOMI_RESIDENTIAL_PROXY_URL)                 # one exit IP for the job
body = {"blockAds": False, "proxyUrl": proxy, "timezone": exit_timezone(proxy)}
session = POST /v1/sessions, body                           # header steel-api-key: <key>
browser = patchright.chromium.connect_over_cdp(session["websocketUrl"] + "?apiKey=" + key)
context = browser.contexts[0]
page = context.pages[0]
...
POST /v1/sessions/{id}/release
```

`sticky()`, `exit_timezone()` and a `Session` context manager that does all of this are in [mosaic/stealth_check.py](mosaic/stealth_check.py).

Release every session. The service allows three independent sessions. A fourth waits up to five seconds and then receives HTTP 429; it cannot replace another browser.

`identity: "ancestry"` keeps a named profile under `/data/profiles`. Names may contain letters, digits, underscores and hyphens. A second claim on a name receives HTTP 409. Without an identity, the profile is unique and deleted on release.

Sessions expire after ten minutes without a connected client or API activity, or after three hours regardless of activity. The released session reports `endReason` and settled `proxyTxBytes` / `proxyRxBytes`. A browser crash ends that session without launching an idle replacement.

Use the returned session-specific `websocketUrl` and `sessionViewerUrl`. Commands use `POST /v1/sessions/{id}/commands`; scrape, screenshot and PDF actions use the same session prefix. The old `/v1/sessions/scrape` style works only when exactly one session exists. Stateless `/v1/scrape`, `/v1/screenshot`, `/v1/pdf` and `/v1/search` create and release a temporary agent session unless supplied `sessionId` or `steel-session-id`.

The service accepts `mode: "agent"` in phase 1. Quiet mode follows in phase 3. Arbitrary profile paths, Selenium and fingerprint injection are removed.

## The API key

Send the key on every request. HTTP clients use the `steel-api-key` header. CDP clients add `?apiKey=` to the session's `websocketUrl`. `/v1/health` needs no key.

## Use Patchright as the client

Stock Playwright sends `Runtime.enable` to every page, which pages detect and which undoes the server-side fixes. Patchright is a drop-in replacement that does not. Mosaic's `.venv` has it.

## The sticky proxy

Evomi reads targeting from the proxy password, with parameters joined by underscores. `sticky()` appends `_country-US_hardsession-<id>`.

- A `hardsession` keeps one IP for as long as Evomi can, which a login or a cleared challenge needs.
- The softer `session-<id>_lifetime-<minutes>` may change IP.
- Use a new ID for each independent job.

Requests from Railway and from a Mac with the same ID leave through the same IP.

## Pass the timezone yourself

The client looks up the exit timezone through the same sticky proxy. Earlier tests changed both proxy stickiness and timezone handling together; they do not establish that Steel used Railway's location. Proxy rotation and differences between geolocation databases remain possible causes of the earlier mismatch.

`exit_timezone()` asks ipwho.is through the same sticky proxy and passes the answer as `timezone`. The browser's timezone has matched its exit IP in every session since.

## PDFs

With `ENABLE_PDF_VIEWER=true`, navigating to a PDF opens Chrome's viewer instead of downloading the file. Fetch PDFs over HTTP with the session's cookies and User-Agent. Mosaic's collector already does this for signed asset URLs.

## Challenges

When a site still shows a challenge, see [STEALTH.md](STEALTH.md#ddos-guard-on-annas-archive) for how DDoS-Guard's checkbox can be clicked.
