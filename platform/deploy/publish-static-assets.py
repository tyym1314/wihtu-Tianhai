#!/usr/bin/env python3
"""Append verified public assets to a release-independent store. Default: read-only."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile

from release_build import (FINGERPRINT, RETAINED_LOCK, SHA256, STATIC_NAMESPACES,
                           file_digest, regular_path, require, static_public_path,
                           verify_retained_assets)

BASE = Path('/opt/oasis')
RESERVE = 3 * 1024 ** 3
REGISTRY = '.registry'
SCHEMA = 'oasis-static-assets-v1'
HEAD_PATH = 'private/static-assets-head.json'
HEAD_SCHEMA = 'oasis-static-assets-head-v1'


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def load_head(base, initialize=False):
    path = regular_path(base, HEAD_PATH, missing=True)
    if not path.exists():
        require(initialize and not (base / 'static-assets').exists()
                and not (base / 'static-assets').is_symlink(), 'STATIC_HEAD_MISSING')
        return None
    head = json.loads(path.read_text())
    require(isinstance(head, dict) and set(head) == {'schema', 'receipts', 'pending'}
            and head['schema'] == HEAD_SCHEMA and isinstance(head['receipts'], list)
            and all(isinstance(value, str) and SHA256.fullmatch(value) for value in head['receipts'])
            and head['receipts'] == sorted(set(head['receipts'])), 'INVALID_STATIC_HEAD')
    pending = head['pending']
    if pending is not None:
        require(isinstance(pending, dict) and set(pending) == {'receipt_sha256', 'manifest_sha256', 'release'}
                and all(isinstance(pending[key], str) and SHA256.fullmatch(pending[key])
                        for key in ('receipt_sha256', 'manifest_sha256'))
                and isinstance(pending['release'], str)
                and re.fullmatch(r'[A-Za-z0-9_-]+', pending['release']), 'INVALID_STATIC_HEAD_PENDING')
    return head


def write_head(base, value, previous):
    require(load_head(base, initialize=previous is None) == previous, 'STATIC_HEAD_CHANGED')
    path = base / HEAD_PATH
    payload = json_bytes(value)
    ensure_write_space(path.parent, len(payload))
    descriptor, name = tempfile.mkstemp(prefix='.static-head-', suffix='.tmp', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fchmod(stream.fileno(), 0o600)
            os.fsync(stream.fileno())
        if previous is None:
            os.link(temporary, path, follow_symlinks=False)
        else:
            os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)
        sync_directory(path.parent)


def public_source(public):
    require(isinstance(public, str), 'INVALID_STATIC_PUBLIC_PATH')
    for source, prefix in STATIC_NAMESPACES.items():
        if public.startswith(prefix):
            name = source + public[len(prefix):]
            require(static_public_path(name) == public, 'INVALID_STATIC_PUBLIC_PATH')
            return name
    name = 'platform/dist' + public
    require(static_public_path(name) == public, 'INVALID_STATIC_PUBLIC_PATH')
    return name


def safe_directory(path, missing=False):
    require(not path.is_symlink(), 'STATIC_DIRECTORY_SYMLINK: ' + str(path))
    require(missing and not path.exists() or path.is_dir(), 'INVALID_STATIC_DIRECTORY: ' + str(path))


def safe_target(store, public, missing=True):
    public_source(public)
    safe_directory(store, missing=missing)
    relative = public.lstrip('/')
    return regular_path(store, relative, missing=missing)


def manifest_assets(release):
    """Old rollback targets need only their declared fingerprint URLs, not a new lock."""
    manifest_path = regular_path(release, 'RELEASE-MANIFEST.json')
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    if isinstance(manifest, dict) and isinstance(manifest.get('files'), dict):
        manifest = manifest['files']
    require(isinstance(manifest, dict) and len(manifest) >= 10, 'INVALID_RELEASE_MANIFEST')
    assets = {}
    for name, digest in manifest.items():
        require(isinstance(name, str), 'UNSAFE_RELEASE_MANIFEST')
        path = PurePosixPath(name)
        require(not path.is_absolute() and '..' not in path.parts and path.as_posix() == name
                and isinstance(digest, str) and SHA256.fullmatch(digest), 'UNSAFE_RELEASE_MANIFEST')
        if any(name.startswith(prefix) for prefix in STATIC_NAMESPACES) and FINGERPRINT.search(path.name):
            public = static_public_path(name)
            source = regular_path(release, name)
            require(file_digest(source) == digest, 'STATIC_SOURCE_HASH_MISMATCH: ' + name)
            assets[public] = {'sha256': digest, 'bytes': source.stat().st_size, 'source': name}
    lock_path = release / RETAINED_LOCK
    if RETAINED_LOCK in manifest:
        lock = verify_retained_assets(release)
        require(file_digest(lock_path) == manifest[RETAINED_LOCK], 'RETAINED_LOCK_MANIFEST_MISMATCH')
        for asset in lock['assets']:
            require(manifest.get(asset['path']) == asset['sha256'], 'UNMANIFESTED_RETAINED_ASSET')
            assets[asset['publicPath']] = {key: asset[key] for key in ('sha256', 'bytes')}
            assets[asset['publicPath']]['source'] = asset['path']
    else:
        require(not lock_path.exists() and not lock_path.is_symlink(), 'UNMANIFESTED_RETAINED_LOCK')
    require(bool(assets), 'NO_DECLARED_STATIC_ASSETS')
    return assets, hashlib.sha256(raw).hexdigest()


def load_registry(store, head, allow_pending=False):
    expected = set(head['receipts']) if head else set()
    pending = head['pending'] if head else None
    require(allow_pending or not pending, 'STATIC_PUBLISH_INCOMPLETE')
    allow_missing = allow_pending and not expected
    safe_directory(store, missing=allow_missing)
    folder = store / REGISTRY
    safe_directory(folder, missing=allow_missing)
    if not folder.exists():
        return {}, set()
    registered = {}
    receipts = set()
    for path in sorted(folder.iterdir()):
        require(not path.is_symlink(), 'STATIC_REGISTRY_SYMLINK')
        # An interrupted atomic write can leave only its private temporary file.
        if path.name.startswith('.publish-') and path.name.endswith('.tmp') and path.is_file():
            continue
        require(path.is_file() and re.fullmatch(r'[a-f0-9]{64}\.json', path.name), 'INVALID_STATIC_RECEIPT_NAME')
        payload = path.read_bytes()
        require(hashlib.sha256(payload).hexdigest() == path.stem, 'STATIC_RECEIPT_HASH_MISMATCH')
        receipt = json.loads(payload)
        require(isinstance(receipt, dict) and receipt.get('schema') == SCHEMA
                and isinstance(receipt.get('manifest_sha256'), str)
                and SHA256.fullmatch(receipt['manifest_sha256'])
                and isinstance(receipt.get('release'), str)
                and re.fullmatch(r'[A-Za-z0-9_-]+', receipt['release'])
                and isinstance(receipt.get('assets'), dict) and bool(receipt['assets']), 'INVALID_STATIC_RECEIPT')
        for public, item in receipt['assets'].items():
            public_source(public)
            require(isinstance(item, dict) and set(item) == {'sha256', 'bytes'}
                    and isinstance(item['sha256'], str) and SHA256.fullmatch(item['sha256'])
                    and type(item['bytes']) is int and item['bytes'] >= 0, 'INVALID_STATIC_REGISTRATION')
            require(public not in registered or registered[public] == item,
                    'STATIC_REGISTRY_CONFLICT: ' + public)
            registered[public] = item
        receipts.add(path.stem)
    require(expected <= receipts, 'STATIC_REGISTERED_RECEIPT_MISSING')
    allowed = expected | ({pending['receipt_sha256']} if allow_pending and pending else set())
    require(receipts <= allowed, 'STATIC_UNANCHORED_RECEIPT')
    require(allow_pending or bool(receipts), 'STATIC_REGISTRY_EMPTY')
    return registered, receipts


def verify_item(path, item, public):
    require(path.is_file() and not path.is_symlink(), 'STATIC_ASSET_MISSING: ' + public)
    require(path.stat().st_size == item['bytes'] and file_digest(path) == item['sha256'],
            'STATIC_ASSET_HASH_MISMATCH: ' + public)


def verify_coverage(release, base=BASE):
    """Caller holds release.lock. Check all published URLs, including newer releases."""
    store = base / 'static-assets'
    required, _ = manifest_assets(release)
    head = load_head(base)
    registered, receipts = load_registry(store, head)
    for public, item in registered.items():
        verify_item(safe_target(store, public), item, public)
    for public, item in required.items():
        expected = {key: item[key] for key in ('sha256', 'bytes')}
        require(registered.get(public) == expected, 'STATIC_COVERAGE_MISSING: ' + public)
    return {'required_assets': len(required), 'registered_assets': len(registered), 'receipts': len(receipts),
            'head_sha256': hashlib.sha256(json_bytes(head)).hexdigest()}


def current_release(base):
    current = base / 'current'
    require(current.is_symlink(), 'INVALID_CURRENT_RELEASE')
    release = current.resolve(strict=True)
    require(release.parent == base / 'releases' and release.is_dir() and not release.is_symlink(),
            'INVALID_CURRENT_RELEASE')
    return release


def space_bound(base, store, missing, wanted, payload_bytes, head_bytes):
    """Bound block allocation, directory entries, receipt and both anchor generations."""
    block, free = filesystem_space(store if store.exists() else base)
    rounded = lambda size: max(block, ((size + block - 1) // block) * block)
    directories = {store, store / REGISTRY}
    for public in missing:
        path = store / public.lstrip('/')
        directories.update(store / parent for parent in path.relative_to(store).parents if str(parent) != '.')
    directory_count = sum(not directory.exists() for directory in directories)
    file_blocks = sum(rounded(wanted[public]['bytes']) for public in missing)
    # Asset/receipt temps are linked, so each has one backing data allocation.
    # The head uses replace: pending + final temp may coexist. Add two blocks per
    # added directory entry/inode, plus each new directory's own block allocation.
    metadata_blocks = (directory_count + 2 * (len(missing) + directory_count + 6)) * block
    extra = file_blocks + rounded(payload_bytes) + 2 * rounded(head_bytes) + metadata_blocks
    return {'allocation_bound_bytes': extra, 'allocation_block_bytes': block,
            'new_directories': directory_count, 'free_bytes': free}


def filesystem_space(path):
    filesystem = os.statvfs(path)
    block = filesystem.f_frsize or filesystem.f_bsize
    require(block >= 512, 'INVALID_STATIC_FILESYSTEM_BLOCK_SIZE')
    return block, filesystem.f_bavail * block


def ensure_write_space(directory, payload_bytes):
    # Other services may consume the preflight margin during a long copy. Recheck
    # each write, including temp/inode/directory-entry headroom, immediately before
    # allocation; a failed publication keeps its pending transaction for retry.
    block, free = filesystem_space(directory)
    allocation = max(block, ((payload_bytes + block - 1) // block) * block) + 8 * block
    require(free - allocation >= RESERVE, 'STATIC_STORE_WRITE_RESERVE_REQUIRED')


@contextmanager
def deployment_lock(base):
    safe_directory(base)
    safe_directory(base / 'private')
    path = base / 'private/release.lock'
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), 'INVALID_RELEASE_LOCK')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def ensure_directory(path, mode=0o755):
    safe_directory(path, missing=True)
    if not path.exists():
        ensure_write_space(path.parent, 0)
        path.mkdir(mode=mode)
        sync_directory(path.parent)


def install_atomic(destination, source, expected):
    """Link a fully synced private temp file into place without ever replacing a URL."""
    ensure_write_space(destination.parent, expected['bytes'])
    descriptor, temporary_name = tempfile.mkstemp(prefix='.publish-', suffix='.tmp', dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        value = hashlib.sha256()
        total = 0
        with os.fdopen(descriptor, 'wb') as target:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                total += len(block)
                require(total <= expected['bytes'], 'STATIC_SOURCE_CHANGED_DURING_COPY')
                value.update(block)
                target.write(block)
            require(total == expected['bytes'] and value.hexdigest() == expected['sha256'],
                    'STATIC_SOURCE_CHANGED_DURING_COPY')
            target.flush()
            os.fchmod(target.fileno(), 0o644)
            os.fsync(target.fileno())
        try:
            os.link(temporary, destination, follow_symlinks=False)
        except FileExistsError:
            verify_item(destination, expected, str(destination))
        sync_directory(destination.parent)
    finally:
        temporary.unlink(missing_ok=True)
        sync_directory(destination.parent)


def publish(release, base=BASE, apply=False):
    safe_directory(base / 'releases')
    require(release.parent == base / 'releases' and release.is_dir() and not release.is_symlink(),
            'RELEASE_OUTSIDE_ROOT')
    with deployment_lock(base):
        required, manifest_sha256 = manifest_assets(release)
        store = base / 'static-assets'
        head = load_head(base, initialize=True)
        registered, receipts = load_registry(store, head, allow_pending=True)
        wanted = {public: {key: item[key] for key in ('sha256', 'bytes')}
                  for public, item in required.items()}
        # Complete preflight catches every conflict before any new public file appears.
        for public, item in registered.items():
            path = safe_target(store, public)
            if path.exists():
                verify_item(path, item, public)
            else:
                require(wanted.get(public) == item, 'REGISTERED_STATIC_ASSET_MISSING: ' + public)
        missing = []
        current = current_release(base)
        for public, item in wanted.items():
            require(public not in registered or registered[public] == item, 'STATIC_URL_CONFLICT: ' + public)
            path = safe_target(store, public)
            if path.exists():
                verify_item(path, item, public)
            else:
                # Until this URL exists in the store, Nginx may serve its actual
                # current-release fallback, including files omitted by old manifests.
                fallback = regular_path(current, public_source(public), missing=True)
                if fallback.exists():
                    require(fallback.stat().st_size == item['bytes'] and file_digest(fallback) == item['sha256'],
                            'STATIC_CURRENT_FALLBACK_CONFLICT: ' + public)
                missing.append(public)
        receipt = {'schema': SCHEMA, 'release': release.name,
                   'manifest_sha256': manifest_sha256, 'assets': wanted}
        payload = json_bytes(receipt)
        receipt_sha256 = hashlib.sha256(payload).hexdigest()
        transaction = {'receipt_sha256': receipt_sha256, 'manifest_sha256': manifest_sha256, 'release': release.name}
        require(not head or head['pending'] is None or head['pending'] == transaction,
                'STATIC_PUBLISH_PENDING_FOR_DIFFERENT_CANDIDATE')
        pending_head = {'schema': HEAD_SCHEMA, 'receipts': head['receipts'] if head else [], 'pending': transaction}
        final_head = {'schema': HEAD_SCHEMA, 'receipts': sorted(set(pending_head['receipts']) | {receipt_sha256}), 'pending': None}
        space = space_bound(base, store, missing, wanted, len(payload),
                            max(len(json_bytes(pending_head)), len(json_bytes(final_head))))
        require(space['free_bytes'] - space['allocation_bound_bytes'] >= RESERVE, 'STATIC_STORE_RESERVE_REQUIRED')
        report = {'status': 'checked', 'release': str(release), 'store': str(store),
                  'required_assets': len(required), 'registered_assets': len(registered),
                  'new_files': len(missing), 'new_file_bytes': sum(wanted[p]['bytes'] for p in missing),
                  **space, 'minimum_remaining_bytes': RESERVE,
                  'receipt_sha256': receipt_sha256, 'manifest_sha256': manifest_sha256,
                  'current_and_mock_unchanged': True}
        if not apply:
            return report
        transaction_needed = bool(missing) or receipt_sha256 not in receipts or bool(head and head['pending'])
        if transaction_needed and head != pending_head:
            write_head(base, pending_head, head)
            head = pending_head
        ensure_directory(store)
        ensure_directory(store / REGISTRY, mode=0o700)
        for public in missing:
            path = safe_target(store, public)
            for parent in reversed(path.relative_to(store).parents):
                if str(parent) != '.':
                    ensure_directory(store / parent)
            source = regular_path(release, required[public]['source'])
            with source.open('rb') as content:
                install_atomic(path, content, wanted[public])
        # A failed/interrupted publish may leave only immutable additions. A retry
        # rechecks them and appends the receipt after every required byte is valid.
        for public, item in wanted.items():
            verify_item(safe_target(store, public), item, public)
        receipt_path = store / REGISTRY / (receipt_sha256 + '.json')
        if receipt_path.exists() or receipt_path.is_symlink():
            require(not receipt_path.is_symlink() and receipt_path.is_file()
                    and receipt_path.read_bytes() == payload, 'STATIC_RECEIPT_CONFLICT')
        else:
            install_atomic(receipt_path, io.BytesIO(payload), {'bytes': len(payload), 'sha256': receipt_sha256})
        if transaction_needed:
            # Do not clear pending or report success if concurrent disk users
            # consumed the reserve after the last asset/receipt was copied.
            require(filesystem_space(store)[1] >= RESERVE
                    and filesystem_space(base / 'private')[1] >= RESERVE, 'STATIC_STORE_RESERVE_REQUIRED')
            write_head(base, final_head, head)
        report.update(status='published', coverage=verify_coverage(release, base))
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check-only', action='store_true')
    mode.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    release = args.release.absolute()
    require(re.fullmatch(r'[0-9]{8}-[0-9]{2}', release.name), 'INVALID_RELEASE_NAME')
    print(json.dumps(publish(release, BASE, apply=args.publish)))


if __name__ == '__main__':
    main()
