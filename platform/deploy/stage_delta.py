#!/usr/bin/env python3
"""Stage a verified transfer delta as a new, independent Oasis release.

The current release is copied rather than hard-linked. This keeps rollback
files immutable when a changed file is written into the candidate directory.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
from release_build import FINGERPRINT, OUTPUT_TREES, RETAINED_LOCK, verify_retained_assets

BASE = Path('/opt/oasis')
_static_spec = importlib.util.spec_from_file_location('stage_static_assets', Path(__file__).with_name('publish-static-assets.py'))
static_assets = importlib.util.module_from_spec(_static_spec)
_static_spec.loader.exec_module(static_assets)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def files_in(manifest):
    if isinstance(manifest, dict) and isinstance(manifest.get('files'), dict):
        manifest = manifest['files']
    if not isinstance(manifest, dict) or len(manifest) < 10:
        raise ValueError('INVALID_RELEASE_MANIFEST')
    for name, value in manifest.items():
        path = PurePosixPath(name)
        if (not isinstance(name, str) or not name or path.is_absolute()
                or '..' in path.parts or path.as_posix() != name
                or not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value)):
            raise ValueError('UNSAFE_RELEASE_MANIFEST')
    return manifest


def verify_tree(root, manifest):
    for name, expected in manifest.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('UNSAFE_RELEASE_PATH: ' + name)
        if digest(path) != expected:
            raise ValueError('RELEASE_HASH_MISMATCH: ' + name)


def static_fingerprints(root):
    """Inspect actual old files, including historic assets omitted by old manifests."""
    result = {}
    for prefix in OUTPUT_TREES:
        directory = root / prefix
        if directory.is_symlink():
            raise ValueError('UNSAFE_STATIC_DIRECTORY: ' + prefix)
        if not directory.exists():
            continue
        for path in directory.rglob('*'):
            if path.is_symlink():
                raise ValueError('UNSAFE_STATIC_PATH: ' + str(path.relative_to(root)))
            if path.is_file() and FINGERPRINT.search(path.name):
                if not path.resolve().is_relative_to(root.resolve()):
                    raise ValueError('UNSAFE_STATIC_PATH')
                result[path.relative_to(root).as_posix()] = digest(path)
    return result


def require_retained_coverage(base, new, static_base=None):
    required = static_fingerprints(base)
    previous_assets = {}
    if (base / RETAINED_LOCK).exists() or (base / RETAINED_LOCK).is_symlink():
        previous = verify_retained_assets(base)
        previous_assets = {asset['path']: asset['sha256'] for asset in previous['assets']}
        required.update(previous_assets)
    missing = {}
    for name, sha256 in required.items():
        if name in new and new[name] != sha256:
            raise ValueError('IMMUTABLE_ASSET_NOT_RETAINED: ' + name)
        if name not in new:
            if name in previous_assets or static_base is None:
                raise ValueError('IMMUTABLE_ASSET_NOT_RETAINED: ' + name)
            missing[name] = sha256
    coverage = None
    if missing:
        # New builds need not embed every previous build's unique chunk. A
        # published, hash-verified stable store can own those exact URLs. The
        # release lock still covers this check and staging; an unlisted old
        # file, changed URL, missing receipt or corrupt store fails closed.
        declared, _ = static_assets.manifest_assets(base)
        by_source = {item['source']: item['sha256'] for item in declared.values()}
        for name, sha256 in missing.items():
            if by_source.get(name) != sha256:
                raise ValueError('IMMUTABLE_ASSET_NOT_REGISTERED: ' + name)
        coverage = static_assets.verify_coverage(base, static_base)
    return required, previous_assets, missing, coverage


def stage(base, candidate, archive, expected_sha256, static_base=None):
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha256):
        raise ValueError('INVALID_DELTA_SHA256')
    if not base.is_dir() or candidate.exists() or candidate.is_symlink():
        raise ValueError('INVALID_RELEASE_LOCATION')
    if digest(archive) != expected_sha256:
        raise ValueError('DELTA_HASH_MISMATCH')
    old = files_in(json.loads((base / 'RELEASE-MANIFEST.json').read_text()))
    with tarfile.open(archive, 'r:gz') as bundle:
        entries = bundle.getmembers()
        names = [entry.name for entry in entries]
        if len(names) != len(set(names)) or 'RELEASE-MANIFEST.json' not in names:
            raise ValueError('INVALID_DELTA_ENTRIES')
        for entry in entries:
            path = PurePosixPath(entry.name)
            if (not entry.isfile() or path.is_absolute() or '..' in path.parts
                    or path.as_posix() != entry.name):
                raise ValueError('UNSAFE_DELTA_ENTRY')
        new = files_in(json.load(bundle.extractfile('RELEASE-MANIFEST.json')))
        if RETAINED_LOCK not in new:
            raise ValueError('RETAINED_ASSET_MISSING_FROM_RELEASE_MANIFEST')
        retained, previous_locked, stored, coverage = require_retained_coverage(base, new, static_base)
        changed = {name for name, expected in new.items() if old.get(name) != expected}
        removed = set(old) - set(new)
        if set(names) - {'RELEASE-MANIFEST.json'} != changed:
            raise ValueError('DELTA_MANIFEST_MISMATCH')
        for entry in entries:
            if entry.name != 'RELEASE-MANIFEST.json':
                if hashlib.sha256(bundle.extractfile(entry).read()).hexdigest() != new[entry.name]:
                    raise ValueError('DELTA_ENTRY_HASH_MISMATCH: ' + entry.name)
        try:
            shutil.copytree(base, candidate, symlinks=True)
            # Full and delta releases must agree when a source or mutable URL
            # is deliberately removed. Only remove previously manifested files;
            # runtime dependencies and unrelated unlisted files are untouched.
            for name in sorted(removed):
                path = candidate / name
                relative = PurePosixPath(name)
                if (any((candidate / parent).is_symlink() for parent in (relative, *relative.parents))
                        or not path.is_file() or not path.resolve().is_relative_to(candidate.resolve())):
                    raise ValueError('UNSAFE_REMOVED_RELEASE_PATH: ' + name)
                if digest(path) != old[name]:
                    raise ValueError('REMOVED_RELEASE_HASH_MISMATCH: ' + name)
                path.unlink()
            for entry in entries:
                if entry.name == 'RELEASE-MANIFEST.json':
                    continue
                path = candidate / entry.name
                if path.is_symlink() or not path.resolve().is_relative_to(candidate.resolve()):
                    raise ValueError('UNSAFE_RELEASE_PATH: ' + entry.name)
                parent = path.parent
                while parent != candidate:
                    if parent.is_symlink():
                        raise ValueError('UNSAFE_RELEASE_PARENT: ' + entry.name)
                    parent = parent.parent
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(bundle.extractfile(entry).read())
                path.chmod(entry.mode & 0o777)
            (candidate / 'RELEASE-MANIFEST.json').write_text(json.dumps(new, indent=2) + '\n')
            verify_tree(candidate, new)
            # Repair inherited private build modes as well as new delta members.
            # Only verified manifest files and their ordinary runtime parents are
            # touched; credentials and unlisted runtime state are left alone.
            for name in [*new, 'RELEASE-MANIFEST.json']:
                path = candidate / name
                path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
                parent = path.parent
                while parent != candidate:
                    parent.chmod(0o755)
                    parent = parent.parent
            lock = verify_retained_assets(candidate)
            locked = {asset['path']: asset['sha256'] for asset in lock['assets']}
            if any(locked.get(name) != sha256 for name, sha256 in previous_locked.items()):
                raise ValueError('PREVIOUS_RETAINED_LOCK_ASSET_DROPPED')
            if any(new.get(a['path']) != a['sha256'] for a in lock['assets']):
                raise ValueError('RETAINED_ASSET_MISSING_FROM_RELEASE_MANIFEST')
            if any(new.get(name) != sha256 for name, sha256 in static_fingerprints(candidate).items()):
                raise ValueError('UNMANIFESTED_IMMUTABLE_ASSET')
        except Exception:
            if candidate.exists():
                shutil.rmtree(candidate)
            raise
    return {'previous': str(base), 'candidate': str(candidate),
            'verified_files': len(new), 'changed_files': len(changed),
            'removed_files': len(removed),
            'retained_static_files': len(retained),
            'retained_in_static_store': sorted(stored),
            'static_store_coverage': coverage,
            'delta_sha256': expected_sha256}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release_name', help='New directory name below /opt/oasis/releases')
    parser.add_argument('archive', type=Path)
    parser.add_argument('sha256')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]{8}-[0-9]{2}', args.release_name):
        raise ValueError('INVALID_RELEASE_NAME')
    with static_assets.deployment_lock(BASE):
        base = (BASE / 'current').resolve(strict=True)
        if base.parent != BASE / 'releases':
            raise ValueError('INVALID_CURRENT_RELEASE')
        candidate = BASE / 'releases' / args.release_name
        print(json.dumps(stage(base, candidate, args.archive, args.sha256, static_base=BASE)))


if __name__ == '__main__':
    main()
