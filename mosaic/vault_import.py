#!/usr/bin/env python3
"""Import selected Mosaic logins into the service vault; never print values.

This administration command reads credentials only for transfer. Collectors must
name an identity instead. It does not remove env lines or edit corpus records.
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path('/Users/moi/nosync.nosync/Mosaic')
sys.path.insert(0, str(ROOT / 'scripts'))
from project_env import get_keys


def main():
    names = ('STEEL_URL', 'STEEL_API_KEY', 'ANCESTRY_EMAIL', 'ANCESTRY_PASSWORD',
             'MARY_FERRELL_USERNAME', 'MARY_FERRELL_EMAIL', 'MARY_FERRELL_PASSWORD',
             'HATHITRUST_GOOGLE_EMAIL', 'HATHITRUST_GOOGLE_PASSWORD')
    values = get_keys(names, project=ROOT, use_environment=False)
    groups = {
        'ancestry': {'email': 'ANCESTRY_EMAIL', 'password': 'ANCESTRY_PASSWORD'},
        'mary-ferrell': {'username': 'MARY_FERRELL_USERNAME', 'email': 'MARY_FERRELL_EMAIL', 'password': 'MARY_FERRELL_PASSWORD'},
        'hathitrust-google': {'email': 'HATHITRUST_GOOGLE_EMAIL', 'password': 'HATHITRUST_GOOGLE_PASSWORD'},
    }
    for name, mapping in groups.items():
        fields = {field: values[key] for field, key in mapping.items() if values[key]}
        if not fields.get('password') or not (fields.get('email') or fields.get('username')):
            raise RuntimeError(f'Incomplete credentials for {name}; import stopped')
        req = urllib.request.Request(values['STEEL_URL'].rstrip('/') + '/v1/vault/' + name,
            method='PUT', headers={'steel-api-key': values['STEEL_API_KEY'], 'Content-Type': 'application/json'},
            data=json.dumps({'fields': fields, 'allowedAgents': ['mosaic']}).encode())
        with urllib.request.urlopen(req, timeout=30) as response:
            metadata = json.load(response)
        encoded = json.dumps(metadata)
        if any(value in encoded for value in fields.values()):
            raise RuntimeError('Credential output check failed; values withheld')
        print(json.dumps(metadata))
    print(f'Imported {len(groups)} vault entries; source env fields retained.')


if __name__ == '__main__':
    main()
