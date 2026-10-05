#!/usr/bin/env python3
"""Promote a checked, schema-compatible release without replacing private state."""
import argparse
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.parse

BASE = Path('/opt/oasis')

def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()

def verify_release(release):
    manifest = json.loads((release / 'RELEASE-MANIFEST.json').read_text())
    if isinstance(manifest, dict) and isinstance(manifest.get('files'), dict):
        manifest = manifest['files']
    if not isinstance(manifest, dict) or len(manifest) < 10:
        raise ValueError('INVALID_RELEASE_MANIFEST')
    for name, digest in manifest.items():
        path = release / name
        if Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink() or not path.resolve().is_relative_to(release.resolve()):
            raise ValueError('UNSAFE_RELEASE_PATH')
        if not isinstance(digest, str) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('RELEASE_HASH_MISMATCH: ' + name)
    if not (release / 'platform/node_modules/tsx/package.json').is_file():
        raise ValueError('RELEASE_DEPENDENCIES_MISSING')
    return len(manifest)

def pending():
    query = "SELECT (SELECT count(*) FROM gp_cycles WHERE status NOT IN ('SETTLED','REJECTED')) + (SELECT count(*) FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided'))"
    return int(run(['docker', 'exec', 'oasis-postgres', 'psql', '-U', 'oasis', '-d', 'oasis_platform', '-At', '-c', query]))

def switch(release):
    temp = BASE / ('.current-' + str(os.getpid()))
    temp.symlink_to(release)
    os.replace(temp, BASE / 'current')

def health():
    if run(['docker', 'exec', 'oasis-postgres', 'psql', '-U', 'oasis', '-d', 'oasis_platform', '-At', '-c', 'SELECT 1']) != '1':
        raise RuntimeError('DATABASE_UNHEALTHY')
    # The demo host accepts only the configured canonical Host header.
    config = (BASE / 'private/runtime.env').read_text().splitlines()
    public_origin = next(line.split('=', 1)[1] for line in config if line.startswith('OASIS_PUBLIC_ORIGIN='))
    hostname = urllib.parse.urlsplit(public_origin).netloc
    for _ in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18881/health', timeout=2) as response:
                if json.load(response).get('status') != 'ok':
                    raise ValueError('API_UNHEALTHY')
            with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18885/demo/', headers={'Host': hostname}), timeout=2) as response:
                if response.status != 200:
                    raise ValueError('DEMO_UNHEALTHY')
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError('RELEASE_HEALTH_FAILED')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', help='Existing immutable release directory under /opt/oasis/releases')
    parser.add_argument('--compatible-schema', action='store_true', help='Confirm tests proved additive migration and old/new order compatibility')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    release = Path(args.release).resolve(strict=True)
    if release.parent != BASE / 'releases':
        raise ValueError('RELEASE_OUTSIDE_ROOT')
    with open(BASE / 'private/release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old = (BASE / 'current').resolve(strict=True)
        count = verify_release(release)
        if pending():
            raise RuntimeError('ACTIVE_GAMES_OR_PENDING_SETTLEMENT: finish obligations before promotion')
        if args.check_only:
            print(json.dumps({'verified_files': count, 'pending': 0, 'current': str(old), 'candidate': str(release)}))
            return
        if not args.compatible_schema:
            raise RuntimeError('SCHEMA_COMPATIBILITY_CONFIRMATION_REQUIRED')
        run(['sh', str(old / 'platform/deploy/backup.sh')])
        switched = False
        try:
            run(['systemctl', 'stop', 'oasis-demo', 'oasis-api'])
            # Stopping admission and draining requests closes the preflight race.
            if pending():
                raise RuntimeError('OBLIGATIONS_STARTED_DURING_PREFLIGHT')
            switch(release); switched = True
            run(['systemctl', 'start', 'oasis-api', 'oasis-demo'])
            health()
        except Exception:
            if switched:
                run(['systemctl', 'stop', 'oasis-demo', 'oasis-api'])
                switch(old)
            run(['systemctl', 'start', 'oasis-api', 'oasis-demo'])
            health()
            raise
        report = {'activated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  'previous': str(old), 'current': str(release), 'verified_files': count,
                  'database_and_private_state_preserved': True, 'health': 'passed'}
        destination = BASE / 'private/last-release.json'
        destination.write_text(json.dumps(report, indent=2) + '\n')
        destination.chmod(0o640)
        os.chown(destination, 0, grp.getgrnam('oasis').gr_gid)
        print(json.dumps(report))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Subprocess output may contain configuration; only print fixed diagnostics.
        if isinstance(error, subprocess.CalledProcessError):
            raise SystemExit('RELEASE_COMMAND_FAILED: inspect restricted service logs')
        raise SystemExit(str(error))
