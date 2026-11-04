"""Measure how the self-hosted Steel browser looks to anti-bot systems.

Checks run against the deployed instance through the Evomi proxy:

  stealth_check.py probe [SESSION_OPTIONS_JSON]
      Print the fingerprint signals a page can read (user agent, client hints,
      screen, GPU, cores, plugins, timezone against the exit IP) and the flags
      raised by deviceandbrowserinfo.com's bot test.

  stealth_check.py fingerprints [COUNT]
      Run fingerprint suites through Core and record settled byte totals. Set
      STEEL_BYTE_LEDGER to a temporary JSONL path; the default ceiling is 1 GB.

  stealth_check.py quiet-probe [COUNT]
      Run fingerprint checks while full snapshots and native clicks execute.

  stealth_check.py quiet-routes [COUNT] [--routes-only]
      Run all six routes per exit. --routes-only uses a separately completed
      quiet-probe; otherwise each route group also repeats the bot checks.

  stealth_check.py direct-soak /tmp/steel-direct-soak
      Resume four 20-page batches per direct route over 24 hours and one
      200-page volume check per route. Requires the maxRung API option.

  stealth_check.py routes core|none [ROUTE ...]
      Load each Mosaic collector route that needs a residential IP and report
      pass/fail, seconds and bytes received. Failed pages are saved as a
      screenshot and text file in ./stealth-failures/.

Settings come from the environment, then from the env file named by
STEEL_ENV_FILE (default ~/nosync.nosync/-env/global.env): STEEL_URL,
STEEL_API_KEY. The service owns Evomi Core credentials and sticky exits.
Credentials are never printed.
STEEL_CDP_BASE optionally selects a local WebSocket origin when running the
same checks beside the deployed service.

Each run opens one Steel session at a time and releases it. Do not run two
copies beyond MAX_SESSIONS (production allows three).

The CDP client is Patchright, which does not send Runtime.enable. Set
STEEL_CLIENT=playwright to compare against stock Playwright.

Requires: pip install patchright (and playwright for the comparison)
"""
import json
import fcntl
import http.client
import io
import os
import re
import sys
import time
import uuid
import urllib.parse
import urllib.error
from pathlib import Path

if os.environ.get('STEEL_CLIENT', 'patchright') == 'patchright':
    from patchright.sync_api import sync_playwright, TimeoutError as NavigationTimeout
else:
    from playwright.sync_api import sync_playwright, TimeoutError as NavigationTimeout

NAMES = ('STEEL_URL', 'STEEL_API_KEY')


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


def call(method, path, payload=None, *, keyed=True):
    """Retry reads, releases and keyed mutations after a dropped connection."""
    base = urllib.parse.urlsplit(BASE)
    body = json.dumps(payload).encode() if payload is not None else None
    retryable = method == 'GET' or path.endswith('/release') or path.endswith('/commands') or path.endswith('/challenge') or path in ('/v1/sessions', '/v1/fetch')
    request_key = str(uuid.uuid4())
    headers = {'Content-Type': 'application/json', 'Connection': 'close', 'steel-api-key': KEY}
    if keyed:
        headers['idempotency-key'] = request_key
    for attempt in range(3):
        connection = http.client.HTTPSConnection if base.scheme == 'https' else http.client.HTTPConnection
        conn = connection(base.hostname, base.port, timeout=300 if path == '/v1/fetch' else 120)
        try:
            conn.request(method, base.path + path, body=body,
                         headers=headers)
            response = conn.getresponse()
            data = response.read()
        except (OSError, http.client.HTTPException):
            if retryable and attempt < 2:
                continue
            raise
        finally:
            conn.close()
        if response.status >= 400:
            raise urllib.error.HTTPError(BASE + path, response.status, response.reason,
                                         response.headers, io.BytesIO(data))
        return json.loads(data or b'{}')


class Session:
    """One Steel session driven over CDP; released on exit."""

    def __init__(self, mode='core', options=None):
        body = {'blockAds': False, **(options or {})}
        if mode == 'premium':
            raise ValueError('Only Evomi Core is enabled for these measurements')
        if mode == 'core':
            body['residential'] = {'country': 'US'}
        body.setdefault('sessionId', str(uuid.uuid4()))
        self.body = body
        self.target_id = None

    def __enter__(self):
        check_budget()
        if os.environ.get('STEEL_ACTIVE_SESSION_FILE'):
            Path(os.environ['STEEL_ACTIVE_SESSION_FILE']).write_text(self.body['sessionId'])
        self.info = call('POST', '/v1/sessions', self.body)
        try:
            self.pw = sync_playwright().start()
            self.reconnect()
            return self
        except BaseException:
            record_release(call('POST', f"/v1/sessions/{self.info['id']}/release"))
            if hasattr(self, 'pw'):
                self.pw.stop()
            raise

    def reconnect(self):
        for attempt in range(3):
            try:
                endpoint = self.info['websocketUrl']
                if os.environ.get('STEEL_CDP_BASE'):
                    endpoint = os.environ['STEEL_CDP_BASE'].rstrip('/') + f"/v1/sessions/{self.info['id']}/cdp"
                self.browser = self.pw.chromium.connect_over_cdp(endpoint + '?apiKey=' + KEY, timeout=30000)
                ctx = self.browser.contexts[0]
                self.page = None
                for candidate in ctx.pages or [ctx.new_page()]:
                    cdp = ctx.new_cdp_session(candidate)
                    try:
                        target = cdp.send('Target.getTargetInfo')['targetInfo']['targetId']
                    finally:
                        cdp.detach()
                    if self.target_id is None or target == self.target_id:
                        self.page, self.target_id = candidate, target
                        break
                if self.page is None:
                    raise RuntimeError('The original page no longer exists')
                self.page.set_default_timeout(60000)
                return self.page
            except Exception as error:
                if attempt == 2:
                    raise RuntimeError(str(error).replace(KEY, '[redacted]')) from None
                time.sleep(attempt + 1)

    def __exit__(self, *exc):
        if exc and exc[1]:
            print('Original probe error: ' + type(exc[1]).__name__ + ': ' + str(exc[1]).splitlines()[0].replace(KEY, '[redacted]'), flush=True)
            print('Client state: ' + json.dumps({'connected': self.browser.is_connected(), 'pages': [{'url': p.url, 'closed': p.is_closed()} for c in self.browser.contexts for p in c.pages]}), flush=True)
        # End remote spend before disposing of the client driver.
        self.released = call('POST', f"/v1/sessions/{self.info['id']}/release")
        record_release(self.released)
        try:
            self.browser.close()
        except Exception as error:
            if 'closed' not in str(error).lower():
                raise
        finally:
            self.pw.stop()


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
        navigate(page, 'https://deviceandbrowserinfo.com/are_you_a_bot')
        flags = positive_flags(device_result(page))
        print('deviceandbrowserinfo flags:', flags or 'none')


def native_challenge(session, attempts):
    """The service owns interstitial waits and native challenge input."""
    result = call('POST', f"/v1/sessions/{session.info['id']}/challenge", {'budgetMs': 45000})
    return 'puzzle' if result['status'] == 'challenge_required' else (result.get('actions') or [None])[-1]


def route_check(session, name, out, quiet=False):
    url, check, minimum = ROUTES[name]
    page = session.page
    started = time.monotonic()
    before = call('GET', f"/v1/sessions/{session.info['id']}")
    result = {'name': name, 'status': 'FAIL', 'payloads': 0}
    navigation_started = time.monotonic()
    try:
        navigate(page, url, timeout=60000, retries=result.setdefault('navigationRetries', []))
    except Exception as error:
        result['navigationError'] = str(error).splitlines()[0].replace(KEY, '[redacted]')[:200]
    result['navigationSeconds'] = round(time.monotonic() - navigation_started, 2)
    input_started = time.monotonic()
    if quiet:
        commands(session, [
            {'command': 'mouse', 'action': 'move', 'x': 120, 'y': 140},
            {'command': 'mouse', 'action': 'wheel', 'x': 120, 'y': 140, 'deltaY': 80},
        ])
    result['inputSeconds'] = round(time.monotonic() - input_started, 2)
    title, text = '', ''
    attempts = {}
    deadline = time.monotonic() + 60
    for step in range(30):
        if time.monotonic() >= deadline:
            break
        check_budget(session)
        try:
            n, title, text = page.evaluate('() => [(' + check + '), document.title, (document.body?.innerText || "").slice(0,500)]')
            result['payloads'] = n
        except Exception as error:
            result['readError'] = type(error).__name__
            n = 0
        if n >= minimum and not any(c in title.lower() for c in CHALLENGE):
            result['status'] = 'PASS'
            break
        if quiet and step >= 2:
            try:
                action = native_challenge(session, attempts)
                if action:
                    result.setdefault('challengeActions', []).append(action)
                    if action == 'puzzle':
                        break
            except NavigationTimeout:
                result['challengeReadTimeout'] = True
            except Exception as error:
                if any(message in str(error) for message in (
                    'Execution context was destroyed', 'Frame was detached',
                    'Cannot find context with specified id',
                    'Unable to adopt element handle from a different document',
                )):
                    result['challengeNavigationRaces'] = result.get('challengeNavigationRaces', 0) + 1
                else:
                    raise
        page.wait_for_timeout(2000)
    result['title'] = title
    if result['status'] != 'PASS':
        result['challenge'] = next((c for c in CHALLENGE if c in (title + ' ' + text).lower()), None)
        out.mkdir(parents=True, exist_ok=True)
        shot = out / f"{session.info['id']}-{name}.png"
        try:
            if quiet:
                import base64
                captured = commands(session, [{'command': 'screenshot', 'format': 'png'}])[0]
                shot.write_bytes(base64.b64decode(captured['data']))
            else:
                page.screenshot(path=str(shot))
            shot.with_suffix('.txt').write_text(page.url + '\n\n' + page.inner_text('body', timeout=5000)[:5000])
            result['artifact'] = str(shot)
        except Exception as error:
            result['captureError'] = type(error).__name__
    # The payload has been checked; close its background traffic before the next route.
    navigate(page, 'about:blank')
    after = call('GET', f"/v1/sessions/{session.info['id']}")
    result['bytes'] = sum(after.get(k, 0) - before.get(k, 0) for k in ('proxyTxBytes', 'proxyRxBytes'))
    result['seconds'] = round(time.monotonic() - started, 2)
    print('ROUTE ' + json.dumps(result), flush=True)
    return result


def route(mode, name, out):
    with Session(mode) as session:
        result = route_check(session, name, out)
    return result['status']


def ledger_total():
    path = os.environ.get('STEEL_BYTE_LEDGER')
    if not path or not Path(path).exists():
        return 0
    return sum(json.loads(line)['bytes'] for line in Path(path).read_text().splitlines())


def record_release(info):
    count = info.get('proxyTxBytes', 0) + info.get('proxyRxBytes', 0)
    path = os.environ.get('STEEL_BYTE_LEDGER')
    if path:
        with Path(path).open('a+') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.seek(0)
            existing = {json.loads(line)['id'] for line in f}
            if info['id'] not in existing:
                f.write(json.dumps({'id': info['id'], 'bytes': count, 'hosts': info.get('proxyTraffic', [])}) + '\n')
                f.flush()
    active = os.environ.get('STEEL_ACTIVE_SESSION_FILE')
    if active and Path(active).exists() and Path(active).read_text() == info['id']:
        Path(active).unlink()
    print(f"Settled residential bytes: {count}; ledger total: {ledger_total()}", flush=True)


def check_budget(session=None):
    total = ledger_total()
    if session:
        live = call('GET', f"/v1/sessions/{session.info['id']}")
        total += live.get('proxyTxBytes', 0) + live.get('proxyRxBytes', 0)
    if total >= int(os.environ.get('STEEL_BYTE_LIMIT', '1000000000')):
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


def navigate(page, url, timeout=60000, retries=None):
    """Retry one failed navigation on the same exit, recording every retry."""
    for attempt in range(2):
        try:
            return page.goto(url, timeout=timeout, wait_until='domcontentloaded')
        except Exception as error:
            transport = isinstance(error, NavigationTimeout) or any(code in str(error) for code in (
                'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_RESET',
                'net::ERR_EMPTY_RESPONSE', 'net::ERR_CONNECTION_CLOSED',
                'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_PROXY_CONNECTION_FAILED',
                'net::ERR_SOCKS_CONNECTION_FAILED', 'net::ERR_NETWORK_CHANGED',
            ))
            if attempt or not transport:
                raise
            if retries is not None:
                retries.append({'url': url, 'error': type(error).__name__,
                                'message': str(error).splitlines()[0][:200]})
            print('Navigation retry on the same exit: ' + url, flush=True)
            cdp = page.context.new_cdp_session(page)
            try:
                try:
                    cdp.send('Page.stopLoading')
                except Exception as stop_error:
                    # Chrome's error document has no active Page agent. The
                    # following goto can still start the recorded retry.
                    if 'Not attached to an active page' not in str(stop_error):
                        raise
            finally:
                cdp.detach()


def device_result(page, timeout=60000):
    """Read the site's completed JSON response; empty or invalid output fails."""
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        try:
            text = page.locator('#jsonResult').text_content(timeout=5000)
        except NavigationTimeout:
            continue
        if text and text.strip():
            result = json.loads(text)
            if not isinstance(result, dict) or not isinstance(result.get('isBot'), bool):
                raise ValueError('Detector response has no boolean isBot verdict')
            return result
        page.wait_for_timeout(250)
    raise TimeoutError('Detector did not publish a JSON verdict within 60 seconds')


def positive_flags(result, prefix=''):
    flags = []
    for key, value in result.items():
        name = f'{prefix}.{key}' if prefix else key
        if value is True:
            flags.append(name)
        elif isinstance(value, dict):
            flags.extend(positive_flags(value, name))
    return flags


def rebrowser_result(page, timeout=60000):
    expected = {
        'dummyFn', 'sourceUrlLeak', 'mainWorldExecution', 'runtimeEnableLeak',
        'exposeFunctionLeak', 'navigatorWebdriver', 'viewport', 'pwInitScripts',
        'platformMismatch', 'mobileEmulation', 'documentInterception', 'popupBlocking',
        'ipcFloodingProtection', 'cdpBindingGlobals', 'headless', 'nativeTampering',
        'bypassCsp', 'useragent', 'workerConsistency', 'storagePartitioning',
    }
    neutral = {'sourceUrlLeak', 'mainWorldExecution', 'exposeFunctionLeak'}
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        try:
            raw = page.locator('#detections-json').input_value(timeout=5000)
        except NavigationTimeout:
            continue
        rows = json.loads(raw) if raw.strip() else []
        # Keep positive detections even when another check is still pending.
        if any(r.get('rating', 0) > 0 for r in rows):
            return rows
        if expected <= {r.get('type') for r in rows} and all(
            r.get('rating') == -1 or r.get('type') in neutral for r in rows
        ):
            return rows
        page.wait_for_timeout(250)
    raise TimeoutError('Rebrowser did not finish all 20 checks within 60 seconds')


def commands(session, items):
    path = f"/v1/sessions/{session.info['id']}/commands"
    response = call('POST', path, {'commands': items})
    while response.get('execution', {}).get('state') in ('running', 'queued'):
        response = call('POST', path, {'commands': [
            {'command': 'status', 'execution': response['execution']['id']}
        ]})
    if response.get('execution', {}).get('state') != 'completed':
        raise RuntimeError('Commands failed: ' + json.dumps(response.get('results', response))[:1500])
    return response['results']


def exercise_commands(session):
    results = commands(session, [
        {'command': 'snapshot', 'compact': False},
        {'command': 'mouse', 'action': 'click', 'x': 5, 'y': 5},
    ])
    return {'snapshotChars': len(results[0].get('snapshot', '')), 'nativeClick': results[1].get('ok') is True}


def exit_signals(session, result):
    page = session.page
    retries = result.setdefault('navigationRetries', [])
    navigate(page, 'https://ipwho.is/', timeout=45000, retries=retries)
    ip = json.loads(page.inner_text('body'))
    result['exitIP'] = ip.get('ip')
    result['exitTimezone'] = (ip.get('timezone') or {}).get('id')
    navigate(page, 'https://example.com', retries=retries)
    result['fingerprint'] = page.evaluate(PROBE)
    print('Basic signals: ' + json.dumps(result['fingerprint']), flush=True)


def collect_fingerprint(session, result, exercise=False, deep=True, advisory=False):
    def go(page, url, timeout=60000):
        return navigate(page, url, timeout, result.setdefault('navigationRetries', []))

    def fresh(page):
        new = page.context.new_page()
        page.close()
        session.page = new
        return new

    page = session.page
    exit_signals(session, result)
    if exercise:
        exercise_commands(session)  # Enable the command reader before detector code loads.
    check_budget(session)
    print('Probe: deviceandbrowserinfo', flush=True)
    go(page, 'https://deviceandbrowserinfo.com/are_you_a_bot')
    if exercise:
        result.setdefault('commandChecks', {})['device'] = exercise_commands(session)
    result['deviceResult'] = device_result(page)
    result['deviceFlags'] = positive_flags(result['deviceResult'])
    print('Device flags: ' + json.dumps(result['deviceFlags']), flush=True)
    page = fresh(page)
    if exercise:
        exercise_commands(session)
    print('Probe: rebrowser', flush=True)
    go(page, 'https://bot-detector.rebrowser.net/')
    main_value(page, 'window.dummyFn()')
    page.evaluate("document.getElementById('detections-json')")
    page.evaluate("document.getElementsByClassName('div')")
    if exercise:
        result.setdefault('commandChecks', {})['rebrowser'] = exercise_commands(session)
    result['rebrowser'] = [{k: r.get(k) for k in ('type', 'rating', 'note')} for r in rebrowser_result(page)]
    check_budget(session)
    print('Rebrowser ratings: ' + json.dumps({r['type']: r['rating'] for r in result['rebrowser']}), flush=True)
    if deep:
        page = fresh(page)
        print('Probe: workers', flush=True)
        go(page, 'https://abrahamjuliot.github.io/creepjs/tests/workers.html')
        page.wait_for_timeout(10000)
        workers = page.locator('.worker').all_inner_texts()
        result['workerHardware'] = [re.findall(r'hardware[^\n]*', text) for text in workers]
        print('Worker hardware: ' + json.dumps(result['workerHardware']), flush=True)
        page = fresh(page)
        print('Probe: creepjs', flush=True)
        go(page, 'https://abrahamjuliot.github.io/creepjs/')
        page.wait_for_timeout(15000)
        result['creep'] = main_value(page, 'window.Fingerprint && ({lies: Fingerprint.lies, headless: Fingerprint.headless, worker: Fingerprint.workerScope})')
        print('CreepJS: ' + json.dumps({k: (result['creep'] or {}).get(k) for k in ['lies', 'headless']}), flush=True)
        check_budget(session)
        print('Probe: webrtc', flush=True)
        go(page, 'https://browserleaks.com/webrtc')
        page.wait_for_timeout(8000)
        result['webrtc'] = page.inner_text('body')[:18000]
    try:
        go(page, 'https://browserleaks.com/tcp', timeout=45000)
        tcp = page.locator('tr').all_inner_texts()
        result['tcpOS'] = next((row for row in tcp if 'Zardaxt OS Scoring' in row), 'No OS score returned')
        result['tcpFingerprint'] = [row for row in tcp if any(k in row for k in ['JA4T Fingerprint', 'Satori Signature', 'Initial TTL'])]
    except Exception as error:
        result['tcpOS'] = 'Unavailable: ' + type(error).__name__
    if advisory:
        for name, url in [('browserscan', 'https://www.browserscan.net/'), ('pixelscan', 'https://pixelscan.net/fingerprint-check')]:
            try:
                go(page, url)
                page.wait_for_timeout(15000)
                result[name] = page.inner_text('body')[:9000]
            except Exception as error:
                result[name] = type(error).__name__
            check_budget(session)
    if exercise:
        result['commandMethods'] = call('GET', f"/v1/sessions/{session.info['id']}").get('commandMethods', [])
        forbidden = [m for m in result['commandMethods'] if m == 'Runtime.enable' or m.startswith(('Input.', 'Log.', 'Network.', 'Fetch.'))]
        if forbidden:
            raise RuntimeError('Quiet policy violation: ' + ', '.join(forbidden))
        if 'Accessibility.getFullAXTree' not in result['commandMethods']:
            raise RuntimeError('Full accessibility tree was not exercised')
    return page


def fingerprints(count=1, quiet=False):
    if not os.environ.get('STEEL_BYTE_LEDGER'):
        raise RuntimeError('Set STEEL_BYTE_LEDGER to a scratch JSONL path')
    rows = []
    for number in range(count):
        result = {'run': number + 1, 'mode': 'quiet' if quiet else 'agent', 'tcpOS': 'not supplied by these probes'}
        try:
            with Session('core', {'mode': 'quiet'} if quiet else None) as session:
                collect_fingerprint(session, result, exercise=quiet, advisory=number == 0 and not os.environ.get('STEEL_SKIP_ADVISORY'))
        except Exception as error:
            result['error'] = type(error).__name__
            result['errorMessage'] = str(error).splitlines()[0].replace(KEY, '[redacted]')[:250]
        rows.append(result)
        print('FINGERPRINT ' + json.dumps(result), flush=True)
        check_budget()
    print(f"Fingerprint sessions measured: {len(rows)}; residential bytes: {ledger_total()}", flush=True)
    return rows


def quiet_routes(count=1, detectors=True):
    if not os.environ.get('STEEL_BYTE_LEDGER'):
        raise RuntimeError('Set STEEL_BYTE_LEDGER to a scratch JSONL path')
    rows = []
    out = Path(os.environ.get('STEEL_FAILURE_DIR', 'stealth-failures'))
    for number in range(count):
        result = {'run': number + 1, 'mode': 'quiet', 'routes': []}
        try:
            with Session('core', {'mode': 'quiet'}) as session:
                if detectors:
                    collect_fingerprint(session, result, exercise=True, deep=False)
                    if result['deviceFlags'] or any(r['rating'] > 0 for r in result['rebrowser']):
                        raise RuntimeError('Positive detection; route checks stopped')
                else:
                    result['botChecks'] = 'separate quiet-probe required on this build'
                    exit_signals(session, result)
                    navigate(session.page, 'https://browserleaks.com/tcp')
                    result['tcpOS'] = next((r for r in session.page.locator('tr').all_inner_texts() if 'Zardaxt OS Scoring' in r), 'No OS score returned')
                    result['commandCheck'] = exercise_commands(session)
                for name in ROUTES:
                    result['routes'].append(route_check(session, name, out, quiet=True))
                result['commandMethods'] = call('GET', f"/v1/sessions/{session.info['id']}").get('commandMethods', [])
            for first in result['routes']:
                transport_error = any(code in first.get('navigationError', '') for code in (
                    'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED',
                    'net::ERR_EMPTY_RESPONSE', 'net::ERR_TUNNEL_CONNECTION_FAILED',
                    'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_SOCKS_CONNECTION_FAILED',
                ))
                if first['status'] == 'PASS' or (first['name'] != 'annas' and not transport_error):
                    continue
                retry = {'name': first['name']}
                with Session('core', {'mode': 'quiet'}) as session:
                    exit_signals(session, retry)
                    navigate(session.page, 'https://browserleaks.com/tcp')
                    retry['tcpOS'] = next((r for r in session.page.locator('tr').all_inner_texts() if 'Zardaxt OS Scoring' in r), 'No OS score returned')
                    retry['route'] = route_check(session, first['name'], out, quiet=True)
                if first['name'] == 'annas':
                    result['annasRetry'] = retry
                else:
                    result.setdefault('transportRetries', []).append(retry)
        except Exception as error:
            result['error'] = type(error).__name__
            result['errorMessage'] = str(error).splitlines()[0].replace(KEY, '[redacted]')[:1500]
        rows.append(result)
        print('QUIET_ROUTES ' + json.dumps(result), flush=True)
        check_budget()
    print(f"Quiet route rounds: {len(rows)}; residential bytes: {ledger_total()}; failure artifacts: {out}", flush=True)
    return rows



def direct_soak(output, immediate=False, routes=('annas', 'udn', 'newspapers')):
    """Resume four direct batches over 24 hours and collector-sized volume reads.

    State holds raw measurements in the supplied scratch directory. No credentials,
    account pages or corpus writes belong here. A pause file stops new sessions.
    """
    from datetime import datetime, timezone
    import signal
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    state_file = output / 'state.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {
        'began': None, 'batches': [], 'volumes': [], 'egress': [], 'failures': []}
    if immediate:
        state['timing'] = 'immediate; 24-hour requirement withdrawn'
    lock = (output / 'runner.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def save():
        tmp = state_file.with_suffix('.tmp')
        tmp.write_text(json.dumps(state, indent=2))
        tmp.replace(state_file)

    def now():
        return datetime.now(timezone.utc).isoformat()

    def wait_ready(needs_slot=True):
        while True:
            if (output / 'stop').exists():
                raise RuntimeError('Direct soak stopped by control file')
            if (output / 'pause').exists():
                time.sleep(15)
                continue
            health = call('GET', '/health')
            if health['status'] == 'ok' and (not needs_slot or health['liveSessions'] < health['maxSessions']):
                return health
            time.sleep(15)

    def ip(session):
        session.page.goto('https://api.ipify.org/?format=json', wait_until='domcontentloaded', timeout=30000)
        value = json.loads(session.page.inner_text('body'))['ip']
        import ipaddress
        ipaddress.ip_address(value)
        row = {'at': now(), 'ip': value, 'health': call('GET', '/health')}
        state['egress'].append(row)
        save()
        return value

    def read_page(session, route, url):
        began = time.monotonic()
        row = {'at': now(), 'route': route, 'url': url, 'pass': False}
        try:
            response = session.page.goto(url, wait_until='domcontentloaded', timeout=60000)
            row['httpStatus'] = response.status if response else None
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                data = session.page.evaluate('() => ({count: (' + ROUTES[route][1] + '), title: document.title, text: (document.body?.innerText || "").slice(0,1200)})')
                blocked = any(x in (data['title'] + ' ' + data['text']).lower() for x in CHALLENGE)
                row['challengeSeen'] = row.get('challengeSeen', False) or blocked
                if data['count'] >= ROUTES[route][2] and not blocked:
                    row.update({'pass': True, 'payloads': data['count'], 'title': data['title']})
                    break
                time.sleep(2)
            if not row['pass']:
                row['error'] = 'payload_missing'
        except Exception as error:
            row['error'] = type(error).__name__
            # Reattach to the existing target; a second navigation would hide
            # the first-attempt failure, so it belongs to the next observation.
            try:
                session.reconnect()
            except Exception:
                row['reattachFailed'] = True
        row['seconds'] = round(time.monotonic() - began, 3)
        print('DIRECT ' + json.dumps(row), flush=True)
        return row

    def http_page(route, url):
        began = time.monotonic()
        # This is a read-only HTTP GET with no browser allocation or residential
        # fallback. Keeping every HTML response in the mutation cache is unnecessary.
        result = call('POST', '/v1/fetch', {'url': url, 'route': route, 'startRung': 1, 'maxRung': 1, 'retry': False}, keyed=False)
        attempts = result.get('attempts', [])
        return {'at': now(), 'route': route, 'url': url, 'pass': result.get('status') == 'ok',
                'rung': result.get('rung'), 'attempts': attempts,
                'seconds': round(time.monotonic() - began, 3),
                'challengeSeen': any(not a.get('pass') for a in attempts)}

    def require_residential(route, reason):
        if any(r['route'] == route for r in state['failures']):
            return
        host = urllib.parse.urlsplit(ROUTES[route][0]).hostname
        call('PUT', '/v1/routing/policies/' + host,
             {'split': True, 'startRung': 3, 'ttlSeconds': 604800})
        state['failures'].append({'route': route, 'at': now(), 'reason': reason})
        save()

    for batch_number in range(4):
        if state['began'] is not None:
            due = state['began'] + batch_number * (0 if immediate else 8 * 3600)
            while time.time() < due:
                if (output / 'stop').exists():
                    raise RuntimeError('Direct soak stopped by control file')
                time.sleep(min(30, due - time.time()))
        for route in routes:
            if immediate and batch_number and any(f['route'] == route for f in state['failures']):
                continue
            key = (batch_number + 1, route)
            batch = next((b for b in state['batches'] if (b['batch'], b['route']) == key), None)
            if batch is None:
                batch = {'batch': key[0], 'route': route, 'rows': [], 'started': now()}
                state['batches'].append(batch)
            if len(batch['rows']) < 20:
                wait_ready()
                if state['began'] is None:
                    state['began'] = time.time()
                    save()
                with Session('none', {'mode': 'agent'}) as session:
                    address = ip(session)
                    while len(batch['rows']) < 20:
                        row = http_page(route, ROUTES[route][0]) if route == 'newspapers' else read_page(session, route, ROUTES[route][0])
                        row['ip'] = address
                        batch['rows'].append(row)
                        save()
                        time.sleep(2)
            batch['passed'] = sum(r['pass'] for r in batch['rows'])
            batch.setdefault('completed', now())
            if batch['passed'] < 19:
                require_residential(route, 'batch_below_19_of_20')
            save()
            print(f"Direct batch {key}: {batch['passed']}/20; state: {state_file}", flush=True)
        if batch_number == 0:
            if (output / 'pause-after-batch').exists():
                (output / 'pause').touch()
                (output / 'pause-after-batch').unlink()
            for route in routes:
                volume = next((v for v in state['volumes'] if v['route'] == route), None)
                if immediate and any(f['route'] == route for f in state['failures']):
                    if volume is not None:
                        volume['passed'] = sum(r['pass'] for r in volume['rows'])
                        volume['stopped'] = now()
                        volume['stopReason'] = 'Route already failed acceptance'
                        save()
                    continue
                if volume is None:
                    volume = {'route': route, 'rows': [], 'started': now()}
                    state['volumes'].append(volume)
                if len(volume['rows']) >= 200:
                    continue
                wait_ready()
                with Session('none', {'mode': 'agent'}) as session:
                    address = ip(session)
                    while len(volume['rows']) < 200:
                        number = len(volume['rows']) + 1
                        if route == 'annas':
                            url = 'https://annas-archive.pk/search?' + urllib.parse.urlencode({'q': ('history', 'science', 'war', 'physics', 'medicine', 'engineering', 'biology', 'art', 'philosophy', 'mathematics')[(number - 1) // 20], 'page': (number - 1) % 20 + 1})
                        elif route == 'udn':
                            url = 'https://newspapers.lib.utah.edu/search?' + urllib.parse.urlencode({'q': 'war', 'rows': 50, 'page': number})
                        else:
                            url = ROUTES[route][0]
                        row = http_page(route, url) if route == 'newspapers' else read_page(session, route, url)
                        row['ip'] = address
                        volume['rows'].append(row)
                        save()
                        # Collector loops issue the next read after parsing;
                        # allow two seconds for that work on these fixtures.
                        time.sleep(2)
                volume['passed'] = sum(r['pass'] for r in volume['rows'])
                volume['completed'] = now()
                if volume['passed'] < 200 or any(r.get('challengeSeen') for r in volume['rows']):
                    require_residential(route, 'volume_block_challenge_or_missing_payload')
                save()
                print(f"Direct volume {route}: {volume['passed']}/200; state: {state_file}", flush=True)
    state['completed'] = now()
    save()
    print(f"Direct acceptance finished: {len(state['batches'])} batches and "
          f"{sum('completed' in v for v in state['volumes'])} completed volume checks; "
          f"observations: {state_file}", flush=True)


def main(argv):
    if len(argv) < 2 or argv[1] not in ('probe', 'routes', 'fingerprints', 'quiet-probe', 'quiet-routes', 'direct-soak'):
        sys.exit(__doc__)
    if argv[1] == 'direct-soak':
        import argparse
        parser = argparse.ArgumentParser(description='Measure direct routes with bounded egress.')
        parser.add_argument('state')
        parser.add_argument('--immediate', action='store_true')
        parser.add_argument('--route', action='append', choices=('annas', 'udn', 'newspapers'))
        args = parser.parse_args(argv[2:])
        direct_soak(args.state, immediate=args.immediate,
                    routes=args.route or ('annas', 'udn', 'newspapers'))
        return
    if argv[1] == 'quiet-routes':
        quiet_routes(int(argv[2]) if len(argv) > 2 else 1, detectors='--routes-only' not in argv)
        return
    if argv[1] in ('fingerprints', 'quiet-probe'):
        fingerprints(int(argv[2]) if len(argv) > 2 else 1, quiet=argv[1] == 'quiet-probe')
        return
    if argv[1] == 'probe':
        probe(json.loads(argv[2]) if len(argv) > 2 else {})
        return
    mode = argv[2] if len(argv) > 2 else 'core'
    if mode not in ('core', 'none'):
        sys.exit('mode must be core or none')
    names = argv[3:] or list(ROUTES)
    results = [route(mode, n, Path('stealth-failures')) for n in names]
    print(f'\n{mode}: {results.count("PASS")}/{len(results)} passed')


if __name__ == '__main__':
    main(sys.argv)
