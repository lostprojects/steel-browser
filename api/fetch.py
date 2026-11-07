"""Bounded Chrome-TLS HTTP reads for the browser service.

Read JSON on stdin. Do not log cookies or proxy URLs, run page scripts, or send
identity cookies during a routing probe. Byte accounting belongs to the forwarder.
"""
import base64
from contextlib import ExitStack
import http.cookiejar
import hashlib
import json
import sys
from curl_cffi import requests


class ResponseTooLarge(Exception):
    pass


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
    limit_hit = False
    try:
        with ExitStack() as resources:
            output = resources.enter_context(open(options["outputPath"], "xb")) if options.get("outputPath") else None
            parts, size, prefix = [], 0, bytearray()
            digest = hashlib.sha256()
            def consume(chunk):
                nonlocal size, limit_hit
                size += len(chunk)
                if size > limit:
                    limit_hit = True
                    raise ResponseTooLarge()
                if output:
                    output.write(chunk)
                    digest.update(chunk)
                    prefix.extend(chunk[:max(0, 5000 - len(prefix))])
                else:
                    parts.append(chunk)
                return len(chunk)
            request = dict(headers=headers, data=options.get("data"), proxy=options.get("proxy"),
                           timeout=options.get("timeout", 30), max_redirects=8)
            if output:
                # The synchronous callback applies disk backpressure to curl;
                # a streaming response queue could otherwise prefetch the body.
                response = session.request(options.get("method", "GET"), url, content_callback=consume, **request)
            else:
                response = resources.enter_context(session.stream(options.get("method", "GET"), url, **request))
                for chunk in response.iter_content():
                    consume(chunk)
        print(json.dumps({"status": response.status_code, "url": response.url,
                          "headers": dict(response.headers), "body": base64.b64encode(bytes(prefix) if output else b"".join(parts)).decode(),
                          **({"bytes": size, "sha256": digest.hexdigest()} if output else {})}))
    except Exception as error:
        # curl errors can contain the full URL; it may carry a signed token.
        kind = "limit" if limit_hit or isinstance(error, ResponseTooLarge) else "transport"
        print(json.dumps({"error": kind}))
        sys.exit(1)
    finally:
        session.close()


if __name__ == "__main__":
    main()
