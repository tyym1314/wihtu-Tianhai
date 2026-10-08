#!/usr/bin/env python3
"""Fixed Mock16/17 staging only. Default checks; no pin/service/schema changes."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import stat
import sys
import types

BASE = Path('/opt/oasis')
RUNTIME_SHA = '67f6f91809f8cee2e9ef0ae8f2655e2d8b2fce0019427bcc3734aa99b7007bc8'
# This script and its exact capsule are reviewed together. No mutable downloader.
ROLES = ('forward', 'rollback')
GROWTH = 32 * 1024 ** 2


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def trusted_path(path, *, directory=False):
    require(path.is_absolute(), 'STAGE_ABSOLUTE_PATH_REQUIRED')
    for part in (path, *path.parents):
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'STAGE_UNTRUSTED_PATH')
        if part != path or directory:
            require(stat.S_ISDIR(info.st_mode), 'STAGE_DIRECTORY_REQUIRED')
    if not directory:
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 16 * 1024 ** 2,
                'STAGE_UNSAFE_CAPSULE_FILE')


def load_adapter(capsule):
    trusted_path(capsule, directory=True)
    path = capsule / 'view_runtime.py'
    trusted_path(path)
    raw = path.read_bytes()
    require(sha(raw) == RUNTIME_SHA, 'STAGE_RUNTIME_HASH_CHANGED')
    module = types.ModuleType('mock_stage_view_runtime')
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    upgrade, views = module.load_verified_helpers()
    require(sha(module.module_bytes(capsule / 'view_database.py')) == module.DATABASE_SHA256,
            'STAGE_DATABASE_HELPER_HASH_CHANGED')
    adapter = object.__new__(module.ViewRuntime)
    adapter.upgrade, adapter.views, adapter.base = upgrade, views, BASE
    adapter.releases = {role: BASE / 'releases' / value[0] for role, value in module.ROLES.items()}
    lock = object.__new__(upgrade.Upgrade)
    lock.base, lock.lock_root = BASE, Path('/run/lock')
    return module, adapter, lock


def absent(path):
    require(not path.exists() and not path.is_symlink(), 'STAGE_TARGET_EXISTS')


def derived_manifest(views, raw, expected):
    require(sha(raw) == expected, 'STAGE_DERIVED_MANIFEST_CHANGED')
    value = views.json_value(raw)  # Rejects duplicate keys, including receipt.
    require(isinstance(value, dict) and 1 < len(value) <= views.MAX_FILES
            and views.RECEIPT in value and views.MANIFEST not in value, 'STAGE_DERIVED_MANIFEST_SHAPE')
    for name, hashed in value.items():
        views.safe_name(name)
        views.digest(hashed)
    return value


def load_inputs(module, adapter, capsule):
    views = adapter.views
    inventory = adapter._inventory()
    old = views.verify_source(adapter.releases['origin'], module.ROLES['origin'][1], inventory=inventory)
    new_manifest, new = adapter._source_new()
    sources = {'old': old['observed'], 'new': new}
    roots = {'old': adapter.releases['origin'], 'new': BASE / 'releases' / module.SOURCE_NEW}
    deps = {name: adapter.installed_dependencies(path) for name, path in roots.items()}
    require(all(value == module.INSTALLED_DEPS for value in deps.values()), 'STAGE_SOURCE_DEPENDENCIES_CHANGED')
    maximum_mtime = max(identity[-2] for source in sources.values() for identity in source['identities'].values())
    result = {}
    for role in ROLES:
        absent(adapter.releases[role])
        folder = capsule / role
        trusted_path(folder, directory=True)
        for name in (views.MANIFEST, views.RECEIPT):
            trusted_path(folder / name)
        raw_manifest = views.read_small(folder / views.MANIFEST)
        raw_receipt = views.read_small(folder / views.RECEIPT)
        manifest = derived_manifest(views, raw_manifest, module.ROLES[role][1])
        require(sha(raw_receipt) == module.RECEIPTS[role] == manifest[views.RECEIPT], 'STAGE_RECEIPT_CHANGED')
        receipt = views.json_value(raw_receipt)
        require(receipt['role'] == role and receipt['source_manifests'] ==
                {'old': module.ROLES['origin'][1], 'new': module.SOURCE_NEW_MANIFEST}, 'STAGE_RECEIPT_SCOPE')
        require(set(manifest) == set(receipt['files']) | {views.RECEIPT}, 'STAGE_RECEIPT_COVERAGE')
        module.validate_publication(receipt, role, maximum_mtime, [receipt['output_mtime_ns']], int(module.time.time()))
        for name, entry in receipt['files'].items():
            views.safe_name(name)
            views.safe_name(entry['path'])
            require(entry['source'] in roots, 'STAGE_SOURCE_ROLE_UNKNOWN')
            original = sources[entry['source']]['files'].get(entry['path'])
            require(original == {key: entry[key] for key in ('sha256', 'bytes', 'mode')}
                    and manifest[name] == entry['sha256'], 'STAGE_SOURCE_BODY_CHANGED')
        result[role] = {'receipt': receipt, 'manifest': manifest, 'raw_manifest': raw_manifest, 'raw_receipt': raw_receipt}
    return result, roots


def rounded(size, block):
    return ((size + block - 1) // block) * block


def dependency_bound(root, block):
    """Independent copies: charge a full block per metadata entry as well."""
    total = 2 * block
    for path in (root / 'platform/node_modules').rglob('*'):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode),
                'STAGE_DEPENDENCY_TYPE')
        total += max(rounded(info.st_size, block), info.st_blocks * 512) + block
    return total


def budget(adapter, inputs, roots):
    usage = os.statvfs(BASE)
    block = max(4096, usage.f_frsize)
    total, free = usage.f_blocks * usage.f_frsize, usage.f_bavail * usage.f_frsize
    bodies = 0
    for item in inputs.values():
        names = set(item['manifest']) | {adapter.views.MANIFEST}
        directories = adapter.views.parents(names)
        bodies += sum(rounded(entry['bytes'], block) + block for entry in item['receipt']['files'].values())
        bodies += rounded(len(item['raw_manifest']), block) + rounded(len(item['raw_receipt']), block)
        bodies += (len(directories) + 5) * block * 2
    copies = bodies + 2 * dependency_bound(roots['old'], block)
    # Read-only fixed Mock query, with no supplied SQL or database identifier.
    database_size = adapter.upgrade.Runtime().database_size()
    require(type(database_size) is int and database_size > 0, 'STAGE_DATABASE_SIZE_INVALID')
    private = BASE / 'android-mock-private'
    adapter.upgrade.mock_private_directory(private)
    private_bytes = 8192
    for path in private.rglob('*'):
        adapter.upgrade.no_link_components(private, path)
        require(path.is_dir() or path.is_file(), 'STAGE_PRIVATE_BACKUP_TYPE')
        private_bytes += 8192
        if path.is_file():
            private_bytes += adapter.upgrade.regular(path).st_size
    backup = 2 * database_size + private_bytes + 64 * 1024 ** 2
    reserve = max(math.ceil(total * 15 / 100), 3 * 1024 ** 3)
    required = copies + backup + GROWTH
    require(free - required >= reserve, 'STAGE_INSUFFICIENT_CAPACITY')
    return {'total_bytes': total, 'free_bytes': free, 'copy_bound_bytes': copies, 'backup_bound_bytes': backup,
            'growth_bytes': GROWTH, 'required_bytes': required, 'retained_bytes': reserve,
            'free_after_bound_bytes': free - required, 'filesystem_block_bytes': block}


def copy_body(views, source, target, entry, timestamp):
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    absent(target)
    with views.regular(source) as (incoming, info):
        require(stat.S_IMODE(info.st_mode) == entry['mode'], 'STAGE_SOURCE_MODE_CHANGED')
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as outgoing:
            hashed, count = views.stream_copy(incoming, outgoing)
            require(hashed == entry['sha256'] and count == entry['bytes'], 'STAGE_SOURCE_CHANGED_DURING_COPY')
            outgoing.flush()
            os.fsync(outgoing.fileno())
    target.chmod(entry['output_mode'])
    os.utime(target, ns=(timestamp, timestamp), follow_symlinks=False)


def write_frozen(target, raw, timestamp):
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(target, 0o644, follow_symlinks=False)
    os.utime(target, ns=(timestamp, timestamp), follow_symlinks=False)


def restore_directories(views, root, files, timestamp):
    # Installing dependencies changes platform's directory mtime. The dependency
    # subtree itself retains its separately verified original metadata.
    for name in sorted(views.parents(files), key=lambda value: len(Path(value).parts), reverse=True):
        path = root / name
        require(not path.is_symlink() and path.is_dir(), 'STAGE_OUTPUT_DIRECTORY_INVALID')
        path.chmod(0o755)
        os.utime(path, ns=(timestamp, timestamp), follow_symlinks=False)
    root.chmod(0o755)
    os.utime(root, ns=(timestamp, timestamp), follow_symlinks=False)


def sync_tree(root):
    # copytree does not fsync its independent dependency copies. Finish all
    # metadata and data before publishing either final directory name.
    directories = []
    for path in (root, *root.rglob('*')):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            continue
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'STAGE_SYNC_UNSAFE_TYPE')
        if stat.S_ISDIR(info.st_mode):
            directories.append(path)
        else:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    for path in reversed(directories):
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def build_one(adapter, item, roots, target):
    views = adapter.views
    target.mkdir(mode=0o755)
    timestamp = item['receipt']['output_mtime_ns']
    for name, entry in sorted(item['receipt']['files'].items()):
        copy_body(views, roots[entry['source']] / entry['path'], target / name, entry, timestamp)
    for name, raw in ((views.MANIFEST, item['raw_manifest']), (views.RECEIPT, item['raw_receipt'])):
        write_frozen(target / name, raw, timestamp)
    shutil.copytree(roots['old'] / 'platform/node_modules', target / 'platform/node_modules', symlinks=True)
    restore_directories(views, target, set(item['manifest']) | {views.MANIFEST}, timestamp)
    sync_tree(target)


def publish_pair(adapter, staged, finals, observation):
    # Both views must already be verified. Two distinct final paths cannot be
    # renamed atomically as a pair. Never delete a successfully published view.
    for role in ROLES:
        absent(finals[role])
    for role in ROLES:
        absent(finals[role])
        os.rename(staged[role], finals[role])
        observation['published'].append(str(finals[role]))
        adapter.upgrade.sync_dir(finals[role].parent)


def execute(capsule, apply, observation):
    require(os.geteuid() == 0, 'STAGE_ROOT_REQUIRED')
    module, adapter, lock = load_adapter(capsule)
    trusted_path(BASE / 'releases', directory=True)
    with lock.locked():
        inputs, roots = load_inputs(module, adapter, capsule)
        capacity = budget(adapter, inputs, roots)
        observation.update({'mode': 'apply' if apply else 'check-only', 'budget': capacity,
                            'pins': {role: {'manifest': module.ROLES[role][1], 'receipt': module.RECEIPTS[role]} for role in ROLES},
                            'source_dependencies': module.INSTALLED_DEPS})
        if not apply:
            return observation
        parent = BASE / 'releases' / ('.mock-views-16-17-staging-' + secrets.token_hex(12))
        parent.mkdir(mode=0o700)
        adapter.upgrade.sync_dir(parent.parent)
        observation['owned_staging'] = str(parent)
        staged = {role: parent / module.ROLES[role][0] for role in ROLES}
        finals = {role: adapter.releases[role] for role in ROLES}
        for role in ROLES:
            build_one(adapter, inputs[role], roots, staged[role])
        adapter.releases.update(staged)
        observation['staged_verification'] = adapter._release_evidence()
        # Fresh gate while all copy storage is already allocated. Charge only the
        # remaining backup/growth reserve; do not double-charge staged bytes.
        usage = os.statvfs(BASE)
        require(usage.f_bavail * usage.f_frsize - capacity['backup_bound_bytes'] - GROWTH >= capacity['retained_bytes'],
                'STAGE_POSTCOPY_CAPACITY_FAILED')
        publish_pair(adapter, staged, finals, observation)
        adapter.releases.update(finals)
        observation['published_verification'] = adapter._release_evidence()
        parent.rmdir()  # Exactly our now-empty parent, never a release tree.
        adapter.upgrade.sync_dir(parent.parent)
        observation['owned_staging_removed'] = True
        return observation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    observation = {'kind': 'mock-view-stage-16-17-v1', 'published': [], 'activation_performed': False,
                   'source_trees_modified': False, 'receipt_bytes_modified': False}
    try:
        execute(Path(__file__).resolve().parent, args.apply, observation)
        observation['status'] = 'passed'
    except Exception as error:
        # No command output, SQL, private configuration or raw captured exception.
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        observation.update(status='failed', error=code, incomplete_staging_preserved=True)
        print(json.dumps(observation, sort_keys=True))
        return 1
    print(json.dumps(observation, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    raise SystemExit(main())
