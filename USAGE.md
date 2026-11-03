# Using the service

## A session from start to finish

```python
proxy = sticky(EVOMI_RESIDENTIAL_PROXY_URL)                 # one exit IP for the job
body = {"blockAds": True, "proxyUrl": proxy, "timezone": exit_timezone(proxy)}
session = POST /v1/sessions, body                           # header steel-api-key: <key>
browser = patchright.chromium.connect_over_cdp(session["websocketUrl"] + "?apiKey=" + key)
context = browser.contexts[0]
page = context.pages[0]
...
POST /v1/sessions/{id}/release
```

`sticky()`, `exit_timezone()` and a `Session` context manager that does all of this are in [mosaic/stealth_check.py](mosaic/stealth_check.py).

Release every session. A local interruption can leave one open, and the next session replaces it anyway, because the instance runs one browser.

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

Steel looks up the exit IP's timezone on its own, but on Railway the lookup returned Railway's location (Ashburn, America/New_York) in three of three sessions, while the browser left through residential IPs in Florida, California and Texas. The cause is not yet known.

`exit_timezone()` asks ipwho.is through the same sticky proxy and passes the answer as `timezone`. The browser's timezone has matched its exit IP in every session since.

## PDFs

With `ENABLE_PDF_VIEWER=true`, navigating to a PDF opens Chrome's viewer instead of downloading the file. Fetch PDFs over HTTP with the session's cookies and User-Agent. Mosaic's collector already does this for signed asset URLs.

## Challenges

When a site still shows a challenge, see [STEALTH.md](STEALTH.md#ddos-guard-on-annas-archive) for how DDoS-Guard's checkbox can be clicked.
