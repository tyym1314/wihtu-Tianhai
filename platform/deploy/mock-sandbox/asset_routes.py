#!/usr/bin/env python3
"""Generate/check an offline Nginx candidate from a verified Mock asset bundle.

No asset installation, network, subprocess, service, reload or upgrade operation.
The candidate deliberately revises the original plan's proposed SHA ETag to
native Nginx validators. This requires HTTP verification before any deployment.
"""
import argparse
import io
import json
import os
from pathlib import Path
import tarfile
import types

_source = Path(__file__).with_name('asset_bundle.py')
bundle = types.ModuleType('mock_asset_routes_bundle')
exec(compile(_source.read_bytes(), str(_source), 'exec'), bundle.__dict__)

HOST = 'oasis-mock.43.98.202.236.sslip.io'
STORE = '/opt/oasis/android-mock-static-assets/20261007-04-to-20261008-05'
MAX_CONFIG_BYTES = 512 * 1024
OUTPUT_NAMES = {'locations.conf', 'adapter.json', 'receipt.json'}


def artifacts(raw):
    # Validate the exact bytes later parsed below, not a separately reopened file
    # or an adjacent plan/receipt that could have different contents.
    checked = bundle.check_bytes(raw)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as tar:
        plan = bundle.json_value(tar.extractfile('BUNDLE-PLAN.json').read())
    bundle.require(plan['scope']['origin'] == 'https://' + HOST, 'ORIGIN_MISMATCH')
    parts = [
        '# OFFLINE CANDIDATE ONLY: do not include before store and HTTP validation.',
        '# Include only inside the existing dedicated Mock HTTPS server.',
        '# Native ETag/Last-Modified intentionally replace the plan SHA ETag.',
        '# Body hashes remain pinned by the bundle; no runtime hash check is implied.',
    ]
    for item in plan['entries']:
        url, member = item['url_path'], item['bundle_member']
        # Both values were independently reconstructed by check_bytes().
        parts += [
            f'location = {url} {{',
            '    recursive_error_pages off;',
            '    error_page 403 404 =404 @oasis_mock_retained_missing;',
            '    error_page 405 =405 @oasis_mock_retained_method;',
            '    if ($scheme != https) { return 404; }',
            f'    if ($http_host !~* "^{HOST.replace(".", "[.]")}(:443)?$") {{ return 404; }}',
            f'    if ($request_uri != "{url}") {{ return 404; }}',
            '    if ($request_method !~ "^(GET|HEAD)$") { return 405; }',
            f'    alias {STORE}/{member};',
            '    disable_symlinks on;',
            '    types { }',
            f'    default_type {item["headers"]["Content-Type"]};',
            '    charset off;',
            '    gzip off;',
            '    etag on;',
            '    if_modified_since exact;',
            '    max_ranges 0;',
            '    expires off;',
            '    add_header Cache-Control "public,max-age=31536000,immutable";',
            '    add_header X-Content-Type-Options nosniff always;',
            '    add_header Referrer-Policy no-referrer always;',
            '}',
        ]
    # Named locations cannot intercept public URLs. Local error_page directives
    # prevent the existing SPA fallback from turning a missing JS file into HTML.
    for name, status, body in (('missing', 404, 'Not found'), ('method', 405, 'Method not allowed')):
        parts += [f'location @oasis_mock_retained_{name} {{', '    internal;',
                  '    recursive_error_pages off;', '    default_type text/plain;',
                  '    add_header Cache-Control no-store always;',
                  '    add_header X-Content-Type-Options nosniff always;']
        if status == 405:
            parts.append('    add_header Allow "GET, HEAD" always;')
        parts += [f'    return {status} "{body}\\n";', '}']
    configuration = ('\n'.join(parts) + '\n').encode()
    bundle.require(len(configuration) <= MAX_CONFIG_BYTES, 'CONFIG_TOO_LARGE')
    contract = {
        'schema': 'mock-asset-routes-candidate-v1', 'origin': 'https://' + HOST,
        'store': STORE, 'bundle_sha256': checked['bundle_sha256'],
        'source_plan_sha256': checked['plan_sha256'],
        'locations_sha256': bundle.sha(configuration),
        'asset_count': plan['count'], 'asset_body_bytes': plan['body_bytes'],
        'entry_contracts': [{key: item[key] for key in ('url_path', 'bundle_member', 'sha256', 'body_bytes')}
                            for item in plan['entries']],
        'revised_validator_contract': {
            'original_proposal': 'ETag: "sha256-<body digest>"',
            'candidate': 'native Nginx ETag and Last-Modified from the installed file',
            'conditions': 'native If-Match/If-None-Match/If-Modified-Since/If-Unmodified-Since semantics; may return 304 or 412',
            'range': 'max_ranges 0: ignore Range/If-Range, send the complete representation for an otherwise successful request',
            'sha_identity': 'bundle manifest and installed-body verification; ETag is not a content hash',
            'get_head': 'native static handler computes Content-Length; HEAD has no body',
        },
        'unresolved_conflicts': plan['unresolved_conflicts'],
        'remaining_gates': plan['remaining_gates'] + [
            'native-validator-contract-review-and-real-nginx-http-tests',
            'exact-dedicated-store-paths-hash-size-mtime-mode-no-links-no-sidecars',
            'parent-config-no-response-body-filters-or-header-inheritance-merge',
        ],
        'apply_allowed': False, 'installed': False, 'http_verified': False,
        'scope': 'offline candidate only; no store bytes, current pin, Nginx template or frozen upgrade gate are changed',
    }
    contract_bytes = bundle.encoded(contract)
    receipt = {'schema': 'mock-asset-routes-receipt-v1', 'bundle_sha256': checked['bundle_sha256'],
               'locations_sha256': bundle.sha(configuration), 'adapter_sha256': bundle.sha(contract_bytes),
               'asset_count': plan['count'], 'unresolved_conflicts': len(plan['unresolved_conflicts']),
               'verified': True, 'apply_allowed': False, 'installed': False, 'http_verified': False}
    return {'locations.conf': configuration, 'adapter.json': contract_bytes,
            'receipt.json': bundle.encoded(receipt)}, receipt


def from_bundle(path):
    with bundle.open_regular(path) as stream:
        raw = stream.read(bundle.MAX_BUNDLE_BYTES + 1)
    return artifacts(raw)


def check_candidate(bundle_path, candidate):
    expected, receipt = from_bundle(bundle_path)
    target = bundle.safe_local_path(candidate)
    bundle.require(target.is_dir() and {p.name for p in target.iterdir()} == OUTPUT_NAMES, 'CANDIDATE_MEMBERS')
    for name, value in expected.items():
        with bundle.open_regular(target / name) as stream:
            actual = stream.read(len(value) + 1)
        bundle.require(actual == value, 'CANDIDATE_MISMATCH')
    return receipt


def generate(bundle_path, output):
    files, receipt = from_bundle(bundle_path)
    target = bundle.safe_local_path(output)
    bundle.require(not any(target == Path(prefix) or Path(prefix) in target.parents for prefix in
                           ('/opt', '/etc', '/run', '/var', '/usr', '/System', '/Library', '/proc', '/sys', '/dev')),
                   'DEPLOYMENT_OUTPUT_FORBIDDEN')
    bundle.require(target.parent.is_dir(), 'OUTPUT_PARENT_MISSING')
    target.mkdir(mode=0o700)
    for name, value in files.items():
        fd = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
    for path in (target, target.parent):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    bundle.require(check_candidate(bundle_path, target) == receipt, 'OUTPUT_READBACK_MISMATCH')
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    create = modes.add_parser('generate')
    create.add_argument('--bundle', required=True)
    create.add_argument('--output', required=True)
    check = modes.add_parser('check')
    check.add_argument('--bundle', required=True)
    check.add_argument('--candidate', required=True)
    args = parser.parse_args(argv)
    try:
        result = generate(args.bundle, args.output) if args.mode == 'generate' else check_candidate(args.bundle, args.candidate)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, tarfile.TarError, UnicodeError, KeyError, TypeError):
        print(json.dumps({'verified': False, 'error': 'ASSET_ROUTES_REFUSED', 'apply_allowed': False}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
