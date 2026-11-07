"""Move an existing Mosaic residential identity to the browser service.

Read the supplied credential file once; do not print its cookies or sticky ID,
change its contents, or create a fresh login. Repeating the import after a
successful migration is unnecessary and may overwrite newer browser cookies.
"""
import argparse
import json
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from stealth_check import call, sync_playwright, KEY


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--country', default='US')
    args = parser.parse_args()
    saved = json.loads(args.file.read_text())
    context = saved.get('context') or {}
    sticky_id = saved.get('proxy_session')
    if not context.get('cookies') or not sticky_id:
        raise ValueError('Source identity needs saved cookies and a sticky ID')
    name = f'residential-{args.country}'
    call('PUT', f'/v1/identities/{name}', {'country': args.country, 'stickyId': sticky_id})
    info = call('POST', '/v1/sessions', {'sessionId': str(uuid.uuid4()), 'mode': 'agent',
                'identity': name, 'residential': {'country': args.country}, 'sessionContext': context})
    try:
        storage_count = 0
        if context.get('localStorage'):
            with sync_playwright() as pw:
                browser = pw.chromium.connect_over_cdp(info['websocketUrl'], headers={'steel-api-key': KEY})
                page = browser.contexts[0].pages[0]
                # Materialize each origin without a site request. The temporary
                # import session permits interception; quiet sessions do not.
                page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<html></html>'))
                for origin, values in context['localStorage'].items():
                    parsed = urlsplit(origin)
                    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/'):
                        raise ValueError('Source storage has an invalid origin')
                    page.goto(origin, wait_until='domcontentloaded')
                    matched = page.evaluate('''values => {
                        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
                        return Object.entries(values).filter(([key, value]) => localStorage.getItem(key) === value).length;
                    }''', values)
                    if matched != len(values):
                        raise RuntimeError('Source local storage was not fully preserved')
                    storage_count += matched
                browser.close()
        stored = call('GET', f"/v1/sessions/{info['id']}/context")
        wanted = {(c['domain'], c.get('path', '/'), c['name'], c['value']) for c in context['cookies']
                  if c.get('expires', -1) <= 0 or c['expires'] > __import__('time').time()}
        actual = {(c['domain'], c.get('path', '/'), c['name'], c['value']) for c in stored.get('cookies', [])}
        missing = len(wanted - actual)
        if missing:
            raise RuntimeError(f'{missing} unexpired source cookies were not preserved')
        print(json.dumps({'identity': name, 'unexpired_cookies_verified': len(wanted),
                          'local_storage_entries_verified': storage_count, 'source_retained': str(args.file)}))
    finally:
        settled = call('POST', f"/v1/sessions/{info['id']}/release")
        print(json.dumps({'migration_residential_bytes': settled['proxyTxBytes'] + settled['proxyRxBytes']}))


if __name__ == '__main__':
    main()
