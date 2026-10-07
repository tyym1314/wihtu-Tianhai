"""Reject stale or partial browser builds before packaging a runtime release."""
import hashlib
import json
from pathlib import Path
import sys

SOURCE_TREES = ('src', 'public', 'platform/src', 'platform/public', 'platform/specs',
                'platform/shared', 'platform/arena', 'platform/legacy', 'platform/android-smoke/app',
                # The partner kit copies wallet modules/examples and derives
                # public math-profile metadata from server code.
                'platform/server', 'platform/examples/partner-wallet')
EXCLUDED = {'dist', 'node_modules', '.local', '__pycache__'}
SOURCE_FILES = ('index.html', 'tiger.html', 'package.json', 'package-lock.json',
                'platform/index.html', 'platform/package.json', 'platform/package-lock.json',
                'platform/vite.config.js', 'platform/scripts/build-legacy.mjs',
                'platform/scripts/build-partner-kit.mjs', 'platform/scripts/build-release.mjs',
                'platform/scripts/android-artifact.mjs', 'platform/android-smoke/prepare-mock-build.mjs',
                'platform/android-smoke/build.sh', 'platform/android-smoke/build-metadata.mjs',
                'platform/deploy/release_build.py', 'platform/mobile-assets.json')
OUTPUT_TREES = ('platform/dist', 'platform/arena/dist', 'platform/legacy/dist')
STAMP = 'platform/release-build-manifest.json'


def fingerprint(root, paths):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(set(paths)) if p.is_file()}


def inputs(root):
    paths = [root / p for p in SOURCE_FILES]
    for directory in SOURCE_TREES:
        paths.extend(p for p in (root / directory).rglob('*')
                     if not EXCLUDED.intersection(p.relative_to(root / directory).parts)
                     and p.name != 'build-manifest.json')
    return fingerprint(root, paths)


def outputs(root):
    for entry in ('platform/dist/index.html', 'platform/arena/dist/index.html',
                  'platform/legacy/dist/thunder.html', 'platform/legacy/dist/tiger.html'):
        if not (root / entry).is_file():
            raise ValueError('MISSING_BROWSER_BUILD: ' + entry)
    return fingerprint(root, [p for directory in OUTPUT_TREES
                              for p in (root / directory).rglob('*')])


def record(root):
    manifest = {'format': 1, 'inputs': inputs(root), 'outputs': outputs(root)}
    (root / STAMP).write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def verify(root):
    stamp = root / STAMP
    if not stamp.is_file():
        raise ValueError('FULL_RELEASE_BUILD_REQUIRED: run npm run build:release')
    manifest = json.loads(stamp.read_text())
    if manifest.get('format') != 1 or manifest.get('inputs') != inputs(root):
        raise ValueError('STALE_BUILD_INPUTS: run npm run build:release')
    if manifest.get('outputs') != outputs(root):
        raise ValueError('STALE_BUILD_OUTPUTS: run npm run build:release')
    return manifest


if __name__ == '__main__':
    repo = Path(__file__).resolve().parents[2]
    action = sys.argv[1] if len(sys.argv) > 1 else 'verify'
    if action not in ('record', 'verify'):
        raise SystemExit('Usage: release_build.py record|verify')
    result = record(repo) if action == 'record' else verify(repo)
    print(json.dumps({'build': action, 'inputs': len(result['inputs']), 'outputs': len(result['outputs'])}))
