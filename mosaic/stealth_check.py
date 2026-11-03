"""Measure how the self-hosted Steel browser looks to anti-bot systems.

Checks run against the deployed instance through the Evomi proxy:

  stealth_check.py probe [SESSION_OPTIONS_JSON]
      Print the fingerprint signals a page can read (user agent, client hints,
      screen, GPU, cores, plugins, timezone against the exit IP) and the flags
      raised by deviceandbrowserinfo.com's bot test.

  stealth_check.py fingerprints [COUNT]
      Run fingerprint suites through Core and record settled byte totals. Set
      STEEL_BYTE_LEDGER to a temporary JSONL path; the default ceiling is 280 MB.

  stealth_check.py quiet-probe [COUNT]
      Run fingerprint checks while full snapshots and native clicks execute.

  stealth_check.py quiet-routes [COUNT]
      Exercise commands during bot checks, then run all six routes per exit.

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
import fcntl
import os
import re
import secrets
import sys
import time
import uuid
import urllib.parse
import urllib.request
from pathlib import Path

if os.environ.get('STEEL_CLIENT', 'patchright') == 'patchright':
    from patchright.sync_api import sync_playwright, TimeoutError as NavigationTimeout
else:
    from playwright.sync_api import sync_playwright, TimeoutError as NavigationTimeout

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
        navigate(session.page, 'https://ipwho.is/', timeout=45000)
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
        body.setdefault('sessionId', str(uuid.uuid4()))
        self.body = body

    def __enter__(self):
        check_budget()
        if os.environ.get('STEEL_ACTIVE_SESSION_FILE'):
            Path(os.environ['STEEL_ACTIVE_SESSION_FILE']).write_text(self.body['sessionId'])
        self.info = call('POST', '/v1/sessions', self.body)
        try:
            self.pw = sync_playwright().start()
            self.browser = self.pw.chromium.connect_over_cdp(self.info['websocketUrl'] + '?apiKey=' + KEY)
            ctx = self.browser.contexts[0] if self.browser.contexts else self.browser.new_context()
            self.page = ctx.pages[0] if ctx.pages else ctx.new_page()
            self.page.set_default_timeout(60000)
            return self
        except BaseException:
            record_release(call('POST', f"/v1/sessions/{self.info['id']}/release"))
            if hasattr(self, 'pw'):
                self.pw.stop()
            raise

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
    """Use native input for visible checkboxes and Bizapedia's drag challenge."""
    page = session.page
    state = page.evaluate(r'''() => {
      const box = e => { if (!e) return null; const r=e.getBoundingClientRect();
        return r.width && r.height && r.x>=0 && r.y>=0 ? [r.x,r.y,r.width,r.height] : null; };
      return {title:document.title.toLowerCase(), text:(document.body?.innerText || '').slice(0,4000).toLowerCase(),
        solved:[...document.querySelectorAll('[name="cf-turnstile-response"], [name="g-recaptcha-response"]')].some(e=>e.value.length>20),
        frames:[...document.querySelectorAll('iframe')].map(e=>({id:e.id,src:e.src,box:box(e)})).filter(e=>e.box)};
    }''')
    if state['solved']:
        return None
    # Turnstile can put its frame inside a closed shadow root. Chrome's frame
    # inventory still exposes its owner, even when document selectors cannot.
    for child in page.frames:
        if 'challenges.cloudflare.com/' not in child.url:
            continue
        owner = child.frame_element()
        box = owner.bounding_box()
        if box and box['x'] >= 0 and box['y'] >= 0:
            state['frames'].append({'id': '', 'src': child.url,
                                    'box': [box['x'], box['y'], box['width'], box['height']]})
    for frame in state['frames']:
        x, y, width, height = frame['box']
        if frame['id'] == 'ddg-iframe':
            element = page.query_selector('#ddg-iframe')
            inner = element.content_frame() if element else None
            text = inner.inner_text('body', timeout=2000).lower() if inner else ''
            if height > 200 or 'type the text' in text or 'captcha' in text:
                return 'puzzle'
            point = (x + 64, y + 36)
        elif 'challenges.cloudflare.com' in frame['src'] and height < 120:
            point = (x + 30, y + height / 2)
        elif 'recaptcha/api2/anchor' in frame['src']:
            point = (x + 28, y + height / 2)
        else:
            continue
        if attempts.get('checkbox', 0) >= 3:
            return None
        attempts['checkbox'] = attempts.get('checkbox', 0) + 1
        page.wait_for_timeout(1000)
        commands(session, [{'command': 'mouse', 'action': 'click', 'x': point[0], 'y': point[1]}])
        page.wait_for_timeout(4000)
        return 'checkbox'
    if 'human verification' in state['text'] and 'drop here' in state['text'] and attempts.get('drag', 0) < 2:
        start = page.get_by_text('Drag', exact=True).first.bounding_box(timeout=2000)
        end = page.get_by_text('Drop here').first.bounding_box(timeout=2000)
        if start and end:
            attempts['drag'] = attempts.get('drag', 0) + 1
            commands(session, [
                {'command': 'mouse', 'action': 'move', 'x': start['x'] + start['width']/2, 'y': start['y'] + start['height']/2},
                {'command': 'mouse', 'action': 'down'},
                {'command': 'mouse', 'action': 'move', 'x': end['x'] + end['width']/2, 'y': end['y'] + end['height']/2},
                {'command': 'mouse', 'action': 'up'},
            ])
            page.wait_for_timeout(1000)
            button = page.get_by_text('Verify You Are Human').first.bounding_box(timeout=2000)
            if button:
                commands(session, [{'command': 'mouse', 'action': 'click', 'x': button['x']+button['width']/2, 'y': button['y']+button['height']/2}])
            page.wait_for_timeout(4000)
            return 'drag'
    return None


def route_check(session, name, out, quiet=False):
    url, check, minimum = ROUTES[name]
    page = session.page
    started = time.monotonic()
    before = call('GET', f"/v1/sessions/{session.info['id']}")
    result = {'name': name, 'status': 'FAIL', 'payloads': 0}
    try:
        navigate(page, url, timeout=60000, retries=result.setdefault('navigationRetries', []))
    except Exception as error:
        result['navigationError'] = str(error).splitlines()[0].replace(KEY, '[redacted]')[:200]
    if quiet:
        commands(session, [
            {'command': 'mouse', 'action': 'move', 'x': 120, 'y': 140},
            {'command': 'mouse', 'action': 'wheel', 'x': 120, 'y': 140, 'deltaY': 80},
        ])
    title, text = '', ''
    attempts = {}
    deadline = time.monotonic() + 60
    for step in range(30):
        if time.monotonic() >= deadline:
            break
        check_budget(session)
        try:
            n, title, text = page.evaluate(check), page.title(), page.inner_text('body', timeout=5000)[:500]
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
                retries.append({'url': url, 'error': type(error).__name__})
            print('Navigation retry on the same exit: ' + url, flush=True)
            cdp = page.context.new_cdp_session(page)
            try:
                cdp.send('Page.stopLoading')
            finally:
                cdp.detach()


def device_result(page, timeout=60000):
    """Read the site's completed JSON response; empty or invalid output fails."""
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        text = page.locator('#jsonResult').text_content(timeout=5000)
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
        raw = page.locator('#detections-json').input_value(timeout=5000)
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


def quiet_routes(count=1):
    if not os.environ.get('STEEL_BYTE_LEDGER'):
        raise RuntimeError('Set STEEL_BYTE_LEDGER to a scratch JSONL path')
    rows = []
    out = Path(os.environ.get('STEEL_FAILURE_DIR', 'stealth-failures'))
    for number in range(count):
        result = {'run': number + 1, 'mode': 'quiet', 'routes': []}
        try:
            with Session('core', {'mode': 'quiet'}) as session:
                collect_fingerprint(session, result, exercise=True, deep=False)
                if result['deviceFlags'] or any(r['rating'] > 0 for r in result['rebrowser']):
                    raise RuntimeError('Positive detection; route checks stopped')
                for name in ROUTES:
                    result['routes'].append(route_check(session, name, out, quiet=True))
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


def main(argv):
    if len(argv) < 2 or argv[1] not in ('probe', 'routes', 'fingerprints', 'quiet-probe', 'quiet-routes'):
        sys.exit(__doc__)
    if argv[1] == 'quiet-routes':
        quiet_routes(int(argv[2]) if len(argv) > 2 else 1)
        return
    if argv[1] in ('fingerprints', 'quiet-probe'):
        fingerprints(int(argv[2]) if len(argv) > 2 else 1, quiet=argv[1] == 'quiet-probe')
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
