"""Bounded Chrome-TLS HTTP reads for the browser service.

Read JSON on stdin. Do not log cookies or proxy URLs, run page scripts, or send
identity cookies during a routing probe. Byte accounting belongs to the forwarder.
"""
import base64
import http.cookiejar
import json
import sys
from curl_cffi import requests


def main():
    options = json.load(sys.stdin)
    url = options["url"]
    if not url.startswith(("http://", "https://")):
        raise ValueError("Only HTTP URLs are accepted")
    limit = options.get("maxBytes", 2_000_000)
    session = requests.Session(impersonate="chrome", trust_env=False)
    for cookie in options.get("cookies", []):
        session.cookies.jar.set_cookie(http.cookiejar.Cookie(
            version=0, name=cookie["name"], value=cookie["value"], port=None,
            port_specified=False, domain=cookie["domain"], domain_specified=cookie["domain"].startswith("."),
            domain_initial_dot=cookie["domain"].startswith("."), path=cookie.get("path", "/"),
            path_specified=True, secure=cookie.get("secure", False),
            expires=int(cookie["expires"]) if cookie.get("expires", -1) > 0 else None,
            discard=False, comment=None, comment_url=None, rest={}, rfc2109=False,
        ))
    headers = options.get("headers", {})
    if options.get("userAgent"):
        headers["User-Agent"] = options["userAgent"]
    if options.get("referer"):
        headers["Referer"] = options["referer"]
    try:
        with session.stream(options.get("method", "GET"), url, headers=headers, data=options.get("data"), proxy=options.get("proxy"), timeout=options.get("timeout", 30),
                            max_redirects=8) as response:
            parts, size = [], 0
            for chunk in response.iter_content():
                size += len(chunk)
                if size > limit:
                    raise ValueError("Response exceeds byte limit")
                parts.append(chunk)
            print(json.dumps({"status": response.status_code, "url": response.url,
                              "headers": dict(response.headers), "body": base64.b64encode(b"".join(parts)).decode()}))
    except Exception as error:
        # curl errors can contain the full URL; it may carry a signed token.
        print(json.dumps({"error": type(error).__name__}))
        sys.exit(1)
    finally:
        session.close()


if __name__ == "__main__":
    main()
