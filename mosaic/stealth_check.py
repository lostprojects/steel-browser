"""Measure how the self-hosted Steel browser looks to anti-bot systems.

Two checks, both run against the deployed instance through the Evomi proxy:

  stealth_check.py probe [SESSION_OPTIONS_JSON]
      Print the fingerprint signals a page can read (user agent, client hints,
      screen, GPU, cores, plugins, timezone against the exit IP) and the flags
      raised by deviceandbrowserinfo.com's bot test.

  stealth_check.py routes core|premium|none [ROUTE ...]
      Load each Mosaic collector route that needs a residential IP and report
      pass/fail, seconds and bytes received. Failed pages are saved as a
      screenshot and text file in ./stealth-failures/.

Settings come from the environment, then from the env file named by
STEEL_ENV_FILE (default ~/nosync.nosync/-env/global.env): STEEL_URL,
STEEL_API_KEY, EVOMI_RESIDENTIAL_PROXY_URL, EVOMI_PREMIUM_PROXY_URL.
Credentials are never printed.

Each run opens one Steel session at a time and releases it. Do not run two
copies beyond MAX_SESSIONS (production allows three).

The CDP client is Patchright, which does not send Runtime.enable. Set
STEEL_CLIENT=playwright to compare against stock Playwright.

Requires: pip install patchright (and playwright for the comparison)
"""
import json
import os
import re
import secrets
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

if os.environ.get('STEEL_CLIENT', 'patchright') == 'patchright':
    from patchright.sync_api import sync_playwright
else:
    from playwright.sync_api import sync_playwright

NAMES = ('STEEL_URL', 'STEEL_API_KEY', 'EVOMI_RESIDENTIAL_PROXY_URL', 'EVOMI_PREMIUM_PROXY_URL')


def load_settings():
    values = {n: os.environ.get(n, '') for n in NAMES}
    env_file = Path(os.environ.get('STEEL_ENV_FILE', '~/nosync.nosync/-env/global.env')).expanduser()
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            m = re.match(r'^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$', line)
            if m and m[1] in values and not values[m[1]]:
                values[m[1]] = m[2].strip().strip('\'"')
    missing = [n for n in ('STEEL_URL', 'STEEL_API_KEY') if not values[n]]
    if missing:
        sys.exit(f'missing {", ".join(missing)} (environment or {env_file})')
    return values


S = load_settings()
BASE, KEY = S['STEEL_URL'].rstrip('/'), S['STEEL_API_KEY']
PROXY = {'core': S['EVOMI_RESIDENTIAL_PROXY_URL'], 'premium': S['EVOMI_PREMIUM_PROXY_URL'], 'none': None}

CHALLENGE = ('ddos-guard', 'just a moment', 'checking your browser', 'access denied',
             'verify you are human', 'attention required', 'unusual traffic', 'are you a robot',
             'human verification', 'browser validation')

# name: (url, JS returning a count of payload elements, minimum count)
ROUTES = {
    'annas':      ('https://annas-archive.pk/search?q=Project+Blue+Book',
                   "document.querySelectorAll('a[href*=\"/md5/\"]').length", 3),
    'bizapedia':  ('https://www.bizapedia.com/people/john-smith.html',
                   "[...document.querySelectorAll('a')].filter(a => /\\/(people|company|officers)\\//.test(a.href)).length", 10),
    'udn':        ('https://newspapers.lib.utah.edu/search?q=flying+saucer',
                   "document.querySelectorAll('a[href*=\"/details\"], a[href*=\"/ark:\"]').length", 3),
    'ancestry':   ('https://www.ancestry.com/account/signin',
                   "document.querySelectorAll('input[type=password], input[type=email], input[name=username]').length + [...document.querySelectorAll('iframe')].filter(f => /signin|login/.test(f.src)).length", 1),
    'newspapers': ('https://www.newspapers.com/signin/',
                   "document.querySelectorAll('input[type=password], input[type=email]').length", 1),
    'fold3':      ('https://www.fold3.com/login',
                   "document.querySelectorAll('input[type=password], input[type=email], input[name=username]').length", 1),
}

PROBE = r"""async () => {
  const c = document.createElement('canvas'); const gl = c.getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const ua = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['platform','fullVersionList']) : null;
  return {
    userAgent: navigator.userAgent, platform: navigator.platform,
    clientHints: ua && {platform: ua.platform, brands: (ua.fullVersionList || []).map(b => b.brand + ' ' + b.version)},
    webdriver: navigator.webdriver, languages: navigator.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory,
    screen: [screen.width, screen.height], window: [window.outerWidth, window.outerHeight],
    plugins: navigator.plugins.length,
    webglVendor: dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
    webglRenderer: dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
    mediaDevices: navigator.mediaDevices ? (await navigator.mediaDevices.enumerateDevices()).length : null,
  };
}"""


def call(method, path, payload=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(payload).encode() if payload is not None else None,
                                 headers={'Content-Type': 'application/json', 'steel-api-key': KEY})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b'{}')


def sticky(proxy_url):
    """US exit that keeps one IP for as long as Evomi can (hardsession)."""
    u = urllib.parse.urlsplit(proxy_url)
    pw = f'{u.password}_country-US_hardsession-{secrets.token_hex(4)}'
    return f'{u.scheme}://{u.username}:{pw}@{u.hostname}:{u.port}'


def exit_timezone(proxy_url):
    """Timezone of the proxy's exit IP, looked up through that proxy.

    Steel's own lookup sometimes returns the server's timezone instead, so the
    client passes the timezone explicitly.
    """
    # A short metered session keeps the preflight within the same byte ledger.
    with Session('none', {'proxyUrl': proxy_url, 'timezone': 'UTC'}) as session:
        session.page.goto('https://ipwho.is/', timeout=45000)
        data = json.loads(session.page.inner_text('body'))
    zone = (data.get('timezone') or {}).get('id')
    if not zone:
        raise RuntimeError('Exit geolocation returned no timezone')
    return zone



class Session:
    """One Steel session driven over CDP; released on exit."""

    def __init__(self, mode='core', options=None):
        body = {'blockAds': False, **(options or {})}
        if PROXY.get(mode):
            body['proxyUrl'] = sticky(PROXY[mode])
            if 'timezone' not in body:
                body['timezone'] = exit_timezone(body['proxyUrl'])
        self.body = body

    def __enter__(self):
        check_budget()
        self.info = call('POST', '/v1/sessions', self.body)
        try:
            self.pw = sync_playwright().start()
            self.browser = self.pw.chromium.connect_over_cdp(self.info['websocketUrl'] + '?apiKey=' + KEY)
            ctx = self.browser.contexts[0] if self.browser.contexts else self.browser.new_context()
            self.page = ctx.pages[0] if ctx.pages else ctx.new_page()
            self.bytes = 0
            cdp = ctx.new_cdp_session(self.page)
            cdp.send('Network.enable')
            cdp.on('Network.loadingFinished', lambda e: setattr(self, 'bytes', self.bytes + e.get('encodedDataLength', 0)))
            return self
        except BaseException:
            record_release(call('POST', f"/v1/sessions/{self.info['id']}/release"))
            if hasattr(self, 'pw'):
                self.pw.stop()
            raise

    def __exit__(self, *exc):
        try:
            self.browser.close()
            self.pw.stop()
        finally:
            self.released = call('POST', f"/v1/sessions/{self.info['id']}/release")
            record_release(self.released)


def probe(options):
    print('session options:', {k: v for k, v in options.items() if k not in ('proxyUrl', 'sessionContext')})
    with Session('core', options) as s:
        page = s.page
        page.goto('https://ipwho.is/', timeout=60000)
        ip = json.loads(page.inner_text('body'))
        print(f"exit IP: {ip.get('ip')} {ip.get('city')}, {ip.get('region')} | IP timezone "
              f"{(ip.get('timezone') or {}).get('id')} | {(ip.get('connection') or {}).get('isp')}")
        page.goto('https://example.com', timeout=60000)
        print(json.dumps(page.evaluate(PROBE), indent=1))
        page.goto('https://deviceandbrowserinfo.com/are_you_a_bot', timeout=60000)
        page.wait_for_timeout(8000)
        text = page.inner_text('body')
        i = text.find('"isBot"')
        flags = re.findall(r'"(\w+)": true', text[i:i + 1500]) if i >= 0 else ['(result not found)']
        print('deviceandbrowserinfo flags:', flags or 'none')


def route(mode, name, out):
    url, check, minimum = ROUTES[name]
    t0, verdict, detail, ip = time.time(), 'FAIL', '', '?'
    with Session(mode) as s:
        page = s.page
        try:
            page.goto('https://api.ipify.org', timeout=45000)
            ip = page.inner_text('body').strip()
        except Exception:
            pass
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=90000)
        except Exception as e:
            detail = f'goto {type(e).__name__}: {str(e).splitlines()[0][:90]}'
        n, title, text = 0, '', ''
        for _ in range(20):  # up to ~60 s for interstitials to clear
            try:
                n, title, text = page.evaluate(check), page.title(), page.inner_text('body')[:400]
            except Exception:
                n, title, text = 0, '', ''
            if n >= minimum and not any(c in title.lower() for c in CHALLENGE):
                verdict, detail = 'PASS', f'{n} payload elements'
                break
            page.wait_for_timeout(3000)
        else:
            hit = next((c for c in CHALLENGE if c in (title + ' ' + text).lower()), None)
            detail = (detail or (f'challenge: {hit}' if hit else f'{n} payload elements (need {minimum})')) + f' | title {title[:50]!r}'
            out.mkdir(exist_ok=True)
            shot = out / f'{mode}-{name}.png'
            try:
                page.screenshot(path=str(shot))
                shot.with_suffix('.txt').write_text(page.url + '\n\n' + page.inner_text('body')[:3000])
                detail += f' | saved {shot}'
            except Exception:
                pass
        kb = s.bytes / 1024
    print(f'{mode:8} {name:11} {verdict:4} {time.time() - t0:5.0f}s {kb:7.0f} KB  ip {ip}  {detail}', flush=True)
    return verdict


def ledger_total():
    path = os.environ.get('STEEL_BYTE_LEDGER')
    if not path or not Path(path).exists():
        return 0
    return sum(json.loads(line)['bytes'] for line in Path(path).read_text().splitlines())


def record_release(info):
    count = info.get('proxyTxBytes', 0) + info.get('proxyRxBytes', 0)
    path = os.environ.get('STEEL_BYTE_LEDGER')
    if path:
        with Path(path).open('a') as f:
            f.write(json.dumps({'id': info['id'], 'bytes': count}) + '\n')
    print(f"Settled residential bytes: {count}; ledger total: {ledger_total()}", flush=True)


def check_budget(session=None):
    total = ledger_total()
    if session:
        live = call('GET', f"/v1/sessions/{session.info['id']}")
        total += live.get('proxyTxBytes', 0) + live.get('proxyRxBytes', 0)
    if total >= int(os.environ.get('STEEL_BYTE_LIMIT', '280000000')):
        raise RuntimeError('Residential measurement budget reached')


def main_value(page, expression):
    # Probe-only reads of a site's own published results. The service command
    # engine has a separate policy; this helper does not change that policy.
    cdp = page.context.new_cdp_session(page)
    try:
        result = cdp.send('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if result.get('exceptionDetails'):
            raise RuntimeError('Probe result expression failed')
        return result['result'].get('value')
    finally:
        cdp.detach()


def fingerprints(count=1):
    if not os.environ.get('STEEL_BYTE_LEDGER'):
        raise RuntimeError('Set STEEL_BYTE_LEDGER to a scratch JSONL path')
    rows = []
    for number in range(count):
        result = {'run': number + 1, 'tcpOS': 'not supplied by these probes'}
        try:
            with Session('core') as s:
                page = s.page
                page.goto('https://ipwho.is/', timeout=45000, wait_until='domcontentloaded')
                ip = json.loads(page.inner_text('body'))
                result['exitIP'] = ip.get('ip')
                result['exitTimezone'] = (ip.get('timezone') or {}).get('id')
                page.goto('https://example.com', timeout=60000, wait_until='domcontentloaded')
                result['fingerprint'] = page.evaluate(PROBE)
                check_budget(s)
                page.goto('https://deviceandbrowserinfo.com/are_you_a_bot', timeout=60000, wait_until='domcontentloaded')
                page.wait_for_timeout(8000)
                body = page.inner_text('body')
                i = body.find('"isBot"')
                result['deviceFlags'] = re.findall(r'"(\w+)": true', body[i:i + 2000]) if i >= 0 else ['result_missing']
                page.goto('https://bot-detector.rebrowser.net/', timeout=60000, wait_until='domcontentloaded')
                main_value(page, 'window.dummyFn()')
                page.evaluate("document.getElementById('detections-json')")
                page.evaluate("document.getElementsByClassName('div')")
                page.wait_for_timeout(11000)
                result['rebrowser'] = [{k: r.get(k) for k in ('type', 'rating', 'note')} for r in json.loads(page.locator('#detections-json').input_value())]
                check_budget(s)
                page.goto('https://abrahamjuliot.github.io/creepjs/tests/workers.html', timeout=60000, wait_until='domcontentloaded')
                page.wait_for_timeout(10000)
                workers = page.locator('.worker').all_inner_texts()
                result['workerHardware'] = [re.findall(r'hardware[^\n]*', text) for text in workers]
                page.goto('https://abrahamjuliot.github.io/creepjs/', timeout=60000, wait_until='domcontentloaded')
                page.wait_for_timeout(15000)
                result['creep'] = main_value(page, 'window.Fingerprint && ({lies: Fingerprint.lies, headless: Fingerprint.headless, worker: Fingerprint.workerScope})')
                check_budget(s)
                page.goto('https://browserleaks.com/webrtc', timeout=60000, wait_until='domcontentloaded')
                page.wait_for_timeout(8000)
                result['webrtc'] = page.inner_text('body')[:18000]
                if number == 0:
                    for name, url in [('browserscan', 'https://www.browserscan.net/'), ('pixelscan', 'https://pixelscan.net/')]:
                        try:
                            page.goto(url, timeout=60000, wait_until='domcontentloaded')
                            page.wait_for_timeout(15000)
                            result[name] = page.inner_text('body')[:9000]
                        except Exception as error:
                            result[name] = type(error).__name__
                        check_budget(s)
        except Exception as error:
            result['error'] = type(error).__name__
            result['errorMessage'] = str(error).splitlines()[0].replace(KEY, '[redacted]')[:250]
        rows.append(result)
        print('FINGERPRINT ' + json.dumps(result), flush=True)
        check_budget()
    print(f"Fingerprint sessions measured: {len(rows)}; residential bytes: {ledger_total()}", flush=True)
    return rows


def main(argv):
    if len(argv) < 2 or argv[1] not in ('probe', 'routes', 'fingerprints'):
        sys.exit(__doc__)
    if argv[1] == 'fingerprints':
        fingerprints(int(argv[2]) if len(argv) > 2 else 1)
        return
    if argv[1] == 'probe':
        probe(json.loads(argv[2]) if len(argv) > 2 else {})
        return
    mode = argv[2] if len(argv) > 2 else 'core'
    if mode not in PROXY:
        sys.exit(f'mode must be one of {", ".join(PROXY)}')
    names = argv[3:] or list(ROUTES)
    results = [route(mode, n, Path('stealth-failures')) for n in names]
    print(f'\n{mode}: {results.count("PASS")}/{len(results)} passed')


if __name__ == '__main__':
    main(sys.argv)
