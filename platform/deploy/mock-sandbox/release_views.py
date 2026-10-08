#!/usr/bin/env python3
"""Offline, reproducible derived Mock release views. No activation or installer.

Authenticated source manifests + a separately obtained installed inventory are
inputs, not facts this local builder can establish about a remote machine.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tarfile
import tempfile

MANIFEST = 'RELEASE-MANIFEST.json'
RECEIPT = 'MOCK-VIEW-RECEIPT.json'
SCHEMA = 'mock-release-view-v1'
INVENTORY_SCHEMA = 'mock-installed-nondependency-inventory-v1'
STATIC = ('platform/dist/', 'platform/arena/dist/', 'platform/legacy/dist/',
          'platform/public/', 'platform/specs/examples/partner-host/public/')
MUTABLE = (
    'platform/dist/downloads/android-smoke-build.json',
    'platform/dist/downloads/oasis-partner-sandbox-kit.zip',
    'platform/dist/specs/android-webview-integration.md',
    'platform/dist/specs/third-party-launch-readiness-2026-10-07.md',
)
MAX_FILES = 20000
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 ** 3
MAX_JSON_BYTES = 16 * 1024 * 1024
HISTORICAL_SOURCE_METADATA = 'src/.DS_Store'
FIXED_MTIME_NS = 1700000000 * 1000000000
CHUNK = 1024 * 1024


def require(value, code):
    if not value:
        raise ValueError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + '\n').encode()


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value), 'INVALID_SHA256')
    return value


def json_value(raw):
    require(isinstance(raw, bytes) and len(raw) <= MAX_JSON_BYTES, 'INVALID_JSON_INPUT')
    def pairs(rows):
        result = {}
        for key, value in rows:
            require(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def invalid(_):
        raise ValueError('NONFINITE_JSON')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def safe_name(name):
    require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_./@+-]+', name)
            and all(part not in ('', '.', '..') for part in name.split('/')), 'UNSAFE_PATH')
    require('node_modules' not in name.split('/'), 'DEPENDENCY_IN_SOURCE_MANIFEST')
    return name


def safe_local(value):
    path = Path(os.path.abspath(value))
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode), 'LOCAL_SYMLINK')
        if item != path:
            require(stat.S_ISDIR(info.st_mode), 'LOCAL_PARENT_NOT_DIRECTORY')
    return path


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


@contextmanager
def regular(path):
    path = safe_local(path)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'NOT_SINGLE_REGULAR_FILE')
    require(not before.st_mode & 0o7000, 'SPECIAL_PERMISSION_BITS')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stream = os.fdopen(fd, 'rb')
    try:
        require(fingerprint(before) == fingerprint(os.fstat(fd)), 'SOURCE_CHANGED_ON_OPEN')
        yield stream, before
        require(fingerprint(before) == fingerprint(os.fstat(fd)) == fingerprint(path.lstat()), 'SOURCE_CHANGED_DURING_READ')
    finally:
        stream.close()


def read_small(path):
    with regular(path) as (stream, _):
        raw = stream.read(MAX_JSON_BYTES + 1)
    require(len(raw) <= MAX_JSON_BYTES, 'JSON_TOO_LARGE')
    return raw


def stream_copy(stream, output=None, maximum=MAX_FILE_BYTES):
    hasher, size = hashlib.sha256(), 0
    while True:
        block = stream.read(CHUNK)
        if not block:
            break
        size += len(block)
        require(size <= maximum, 'BODY_TOO_LARGE')
        hasher.update(block)
        if output is not None:
            output.write(block)
    return hasher.hexdigest(), size


def scan_tree(value):
    root = safe_local(value)
    require(root.is_dir(), 'SOURCE_ROOT_NOT_DIRECTORY')
    files, directories, dependencies, identities = {}, [], [], {}
    total = 0
    def visit(folder):
        nonlocal total
        before = folder.lstat()
        require(stat.S_ISDIR(before.st_mode), 'SOURCE_DIRECTORY_CHANGED')
        for path in sorted(folder.iterdir()):
            info = path.lstat()
            name = path.relative_to(root).as_posix()
            require(not stat.S_ISLNK(info.st_mode), 'SOURCE_SYMLINK')
            if path.name == 'node_modules':
                require(name == 'platform/node_modules', 'UNREVIEWED_DEPENDENCY_ROOT')
                require(stat.S_ISDIR(info.st_mode), 'DEPENDENCY_ROOT_NOT_DIRECTORY')
                dependencies.append(name)
                continue  # No dependency content is read, validated or copied.
            safe_name(name)
            require(len(files) + len(directories) < MAX_FILES, 'TREE_TOO_LARGE')
            if stat.S_ISDIR(info.st_mode):
                directories.append(name)
                visit(path)
            else:
                with regular(path) as (stream, observed):
                    hashed, size = stream_copy(stream)
                files[name] = {'sha256': hashed, 'bytes': size, 'mode': stat.S_IMODE(observed.st_mode)}
                identities[name] = fingerprint(observed)
                total += size
                require(total <= MAX_TOTAL_BYTES, 'TREE_BYTES_EXCEEDED')
        require(fingerprint(before) == fingerprint(folder.lstat()), 'DIRECTORY_CHANGED_DURING_SCAN')
    visit(root)
    return {'files': files, 'directories': sorted(directories), 'excluded_dependencies': sorted(dependencies),
            'identities': identities, 'bytes': total}


def validate_manifest(raw, expected_sha):
    require(sha(raw) == digest(expected_sha), 'SOURCE_MANIFEST_SHA_MISMATCH')
    value = json_value(raw)
    require(isinstance(value, dict) and 0 < len(value) <= MAX_FILES, 'MANIFEST_SHAPE')
    for name, hashed in value.items():
        safe_name(name)
        digest(hashed)
        require(name not in (MANIFEST, RECEIPT), 'RESERVED_SOURCE_BODY')
    return value


def record(value):
    require(isinstance(value, dict) and set(value) == {'sha256', 'bytes', 'mode'}, 'INVENTORY_FILE_SHAPE')
    digest(value['sha256'])
    require(type(value['bytes']) is int and 0 <= value['bytes'] <= MAX_FILE_BYTES, 'INVENTORY_SIZE')
    require(type(value['mode']) is int and 0 <= value['mode'] <= 0o777, 'INVENTORY_MODE')


def cache_path(name):
    parts = name.split('/')
    return len(parts) >= 2 and parts[-2] == '__pycache__' and parts[-1].endswith('.pyc')


def validate_inventory(raw, expected_sha, manifest_sha):
    require(sha(raw) == digest(expected_sha), 'INVENTORY_SHA_MISMATCH')
    value = json_value(raw)
    required = {'schema', 'manifest_sha256', 'files', 'directories', 'excluded_caches'}
    require(isinstance(value, dict) and set(value) == required, 'INVENTORY_SHAPE')
    require(value['schema'] == INVENTORY_SCHEMA and value['manifest_sha256'] == manifest_sha, 'INVENTORY_SCOPE')
    require(isinstance(value['files'], dict) and 0 < len(value['files']) <= MAX_FILES, 'INVENTORY_FILES')
    for name, item in value['files'].items():
        safe_name(name)
        record(item)
    require(isinstance(value['directories'], list) and value['directories'] == sorted(set(value['directories'])), 'INVENTORY_DIRECTORIES')
    for name in value['directories']:
        safe_name(name)
        require(name not in value['files'], 'INVENTORY_FILE_DIRECTORY_COLLISION')
    require(isinstance(value['excluded_caches'], dict), 'EXCLUDED_CACHE_SHAPE')
    for name, item in value['excluded_caches'].items():
        safe_name(name)
        record(item)
        require(cache_path(name) and item == value['files'].get(name), 'EXCLUDED_CACHE_NOT_EXACT_INVENTORY_MEMBER')
    return value


def is_static(name):
    return name.startswith(STATIC) and Path(name).suffix.lower() != '.html'


def parents(names):
    return sorted({p.as_posix() for name in names for p in Path(name).parents if p.as_posix() != '.'})


def verify_source(root, manifest_sha, *, inventory=None):
    raw = read_small(Path(root) / MANIFEST)
    declared = validate_manifest(raw, manifest_sha)
    observed = scan_tree(root)
    require(observed['files'].get(MANIFEST, {}).get('sha256') == manifest_sha, 'MANIFEST_CHANGED')
    for name, hashed in declared.items():
        require(name in observed['files'] and observed['files'][name]['sha256'] == hashed, 'DECLARED_SOURCE_MISSING_OR_CHANGED: ' + name)
    extras = set(observed['files']) - set(declared) - {MANIFEST}
    if inventory is None:
        require(not extras, 'NEW_SOURCE_UNDECLARED_EXTRAS')
        require(observed['directories'] == parents(observed['files']), 'NEW_SOURCE_UNDECLARED_DIRECTORY')
        caches = {}
    else:
        require(observed['files'] == inventory['files'] and observed['directories'] == inventory['directories'], 'INSTALLED_INVENTORY_MISMATCH')
        caches = inventory['excluded_caches']
        require(set(caches) <= extras, 'MANIFESTED_CACHE_CANNOT_BE_EXCLUDED')
        for name in extras - set(caches):
            require(is_static(name) and not name.lower().endswith('.pyc'), 'UNCLASSIFIED_OLD_EXTRA: ' + name)
    require(RECEIPT not in observed['files'], 'SOURCE_ALREADY_DERIVED_VIEW')
    require(all(not name.lower().endswith('.pyc') for name in declared), 'MANIFESTED_CACHE_FORBIDDEN')
    metadata = {}
    for name in observed['files']:
        if Path(name).name == '.DS_Store':
            require(inventory is not None and name == HISTORICAL_SOURCE_METADATA and name in declared,
                    'UNCLASSIFIED_SOURCE_METADATA')
            metadata[name] = {**observed['files'][name], 'reason': 'Historical macOS metadata; explicitly excluded from derived views.'}
    return {'manifest': declared, 'observed': observed, 'extras': sorted(extras), 'excluded_caches': caches,
            'excluded_source_metadata': metadata}


def make_plan(old, new, new_manifest_sha):
    def ref(source, name, observed):
        return {'source': source, 'path': name, **observed['files'][name]}
    old_files = {name: ref('old', name, old['observed']) for name in old['observed']['files']
                 if name != MANIFEST and name not in old['excluded_caches'] and name not in old['excluded_source_metadata']}
    new_files = {name: ref('new', name, new['observed']) for name in new['observed']['files'] if name != MANIFEST}
    forward = dict(new_files)
    for name, item in old_files.items():
        if is_static(name):
            existing = forward.get(name)
            require(existing is None or existing['sha256'] == item['sha256'] or name in MUTABLE,
                    'UNCLASSIFIED_STATIC_CONFLICT: ' + name)
            if existing is None:
                forward[name] = item
    versioned = {}
    for name in MUTABLE:
        require(name in old_files and name in new_files, 'MUTABLE_SOURCE_MISSING: ' + name)
        target = 'platform/dist/mock-releases/' + new_manifest_sha + '/' + name.removeprefix('platform/dist/')
        require(target not in old_files and target not in new_files, 'VERSIONED_PATH_ALREADY_EXISTS')
        forward[name] = old_files[name]
        forward[target] = new_files[name]
        versioned[name] = target
    rollback = dict(old_files)
    for name, item in forward.items():
        if is_static(name):
            existing = rollback.get(name)
            require(existing is None or existing['sha256'] == item['sha256'], 'ROLLBACK_STATIC_CONFLICT: ' + name)
            if existing is None:
                rollback[name] = item
    left = {k: v['sha256'] for k, v in forward.items() if is_static(k)}
    right = {k: v['sha256'] for k, v in rollback.items() if is_static(k)}
    require(left == right, 'BIDIRECTIONAL_STATIC_COVERAGE_FAILED')
    for plan in (forward, rollback):
        require(len(plan) + 1 <= MAX_FILES, 'VIEW_TOO_LARGE')
        require(not set(plan) & set(parents(plan)), 'OUTPUT_FILE_DIRECTORY_COLLISION')
        require(MANIFEST not in plan and RECEIPT not in plan, 'RESERVED_OUTPUT_COLLISION')
    return {'forward': forward, 'rollback': rollback}, versioned


def output_mode(mode):
    return 0o755 if mode & 0o111 else 0o644


def write_owned(path, raw, mode=0o644, mtime_ns=FIXED_MTIME_NS):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(mode)
    os.utime(path, ns=(mtime_ns, mtime_ns))


def copy_body(source, target, expected, identity, mtime_ns):
    target.parent.mkdir(parents=True, exist_ok=True)
    with regular(source) as (stream, info):
        require(fingerprint(info) == identity, 'SOURCE_CHANGED_BEFORE_COPY')
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, output_mode(expected['mode']))
        with os.fdopen(fd, 'wb') as output:
            hashed, size = stream_copy(stream, output)
            output.flush()
            os.fsync(output.fileno())
    require(hashed == expected['sha256'] and size == expected['bytes'], 'SOURCE_CHANGED_WHILE_COPYING')
    target.chmod(output_mode(expected['mode']))
    os.utime(target, ns=(mtime_ns, mtime_ns))


def finish_directories(root, mtime_ns=FIXED_MTIME_NS):
    for path in sorted((p for p in root.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        path.chmod(0o755)
        os.utime(path, ns=(mtime_ns, mtime_ns))
    root.chmod(0o755)
    os.utime(root, ns=(mtime_ns, mtime_ns))


def build_views(*, old_root, new_root, old_manifest_sha256, new_manifest_sha256,
                old_inventory, old_inventory_sha256, publication_epoch, output):
    old_root, new_root, output = map(safe_local, (old_root, new_root, output))
    require(old_root != new_root and not old_root.is_relative_to(new_root) and not new_root.is_relative_to(old_root), 'OVERLAPPING_SOURCES')
    require(not any(output == p or output.is_relative_to(p) or p.is_relative_to(output) for p in (old_root, new_root)), 'OUTPUT_OVERLAPS_SOURCE')
    require(not output.exists() and output.parent.is_dir(), 'OUTPUT_EXISTS_OR_PARENT_MISSING')
    inventory = validate_inventory(old_inventory, old_inventory_sha256, old_manifest_sha256)
    old = verify_source(old_root, old_manifest_sha256, inventory=inventory)
    new = verify_source(new_root, new_manifest_sha256)
    require(type(publication_epoch) is int and 0 < publication_epoch < 2147483646,
            'INVALID_PUBLICATION_EPOCH')
    # Nginx derives static validators from mtime/size. Same-size changed HTML
    # must have a newer second on forward AND rollback, including IMS-only clients.
    maximum_mtime = max(identity[5] for source in (old, new)
                        for identity in source['observed']['identities'].values())
    require(publication_epoch * 1000000000 > maximum_mtime,
            'PUBLICATION_MUST_FOLLOW_SOURCE_MTIMES')
    plans, versioned = make_plan(old, new, new_manifest_sha256)
    roots, sources = {'old': old_root, 'new': new_root}, {'old': old, 'new': new}
    common = {
        'schema': SCHEMA, 'derived_view': True, 'original_release_identity': False,
        'source_manifests': {'old': old_manifest_sha256, 'new': new_manifest_sha256},
        'old_installed_inventory_sha256': old_inventory_sha256,
        'publication_epoch': publication_epoch,
        'static_prefixes': list(STATIC), 'html_excluded_from_static_union': True,
        'historical_urls_preserved': list(MUTABLE), 'new_versioned_files': versioned,
        'old_extras': old['extras'], 'excluded_caches': old['excluded_caches'],
        'excluded_source_metadata': old['excluded_source_metadata'],
        'dependencies': {'copied': False, 'verified': False, 'external_validation_and_install_required': True,
                         'observed_excluded_roots': {k: v['observed']['excluded_dependencies'] for k, v in sources.items()}},
        'embedded_build_receipts': 'Unmodified source evidence only; not attestations for the derived view.',
        'activation_performed': False, 'installer_executed': False,
    }
    stage = Path(tempfile.mkdtemp(prefix='.' + output.name + '.mock-view-staging-', dir=output.parent))
    own_identity = (stage.stat().st_dev, stage.stat().st_ino)
    result = {'schema': SCHEMA, 'output': str(output), 'views': {}, 'static_coverage_equal': True}
    try:
        for role, plan in plans.items():
            mtime_ns = (publication_epoch + (role == 'rollback')) * 1000000000
            view = stage / role
            view.mkdir(mode=0o700)
            for name, item in sorted(plan.items()):
                copy_body(roots[item['source']] / item['path'], view / name, item,
                          sources[item['source']]['observed']['identities'][item['path']], mtime_ns)
            receipt = dict(common, role=role, business_and_html_source='new' if role == 'forward' else 'old',
                           output_mtime_ns=mtime_ns,
                           files={name: {**item, 'output_mode': output_mode(item['mode'])} for name, item in sorted(plan.items())})
            raw_receipt = encoded(receipt)
            write_owned(view / RECEIPT, raw_receipt, mtime_ns=mtime_ns)
            manifest = {name: item['sha256'] for name, item in sorted(plan.items())}
            manifest[RECEIPT] = sha(raw_receipt)
            raw_manifest = encoded(manifest)
            write_owned(view / MANIFEST, raw_manifest, mtime_ns=mtime_ns)
            finish_directories(view, mtime_ns)
            checked = scan_tree(view)
            require(set(checked['files']) == set(manifest) | {MANIFEST}, 'OUTPUT_MANIFEST_COVERAGE')
            require(all(checked['files'][name]['sha256'] == hashed for name, hashed in manifest.items()), 'OUTPUT_BODY_VERIFY_FAILED')
            require(checked['directories'] == parents(checked['files']), 'OUTPUT_UNDECLARED_DIRECTORY')
            result['views'][role] = {'manifest_sha256': sha(raw_manifest), 'receipt_sha256': sha(raw_receipt),
                                    'files': len(manifest), 'bytes': checked['bytes'],
                                    'static_files': sum(is_static(name) for name in plan)}
        # Recapture full sources, including excluded cache bytes, before success.
        for source, root in roots.items():
            require(scan_tree(root) == sources[source]['observed'], 'SOURCE_CHANGED_DURING_BUILD')
        # Do not reset role-specific directory timestamps when finishing the pair.
        stage.chmod(0o755)
        os.utime(stage, ns=(publication_epoch * 1000000000,) * 2)
        # This is a trusted, writer-free local parent directory. Do not overwrite
        # a destination that appeared while building; same-UID malicious rename
        # races are outside this offline builder's contract.
        require(not output.exists() and not output.is_symlink(), 'OUTPUT_APPEARED_DURING_BUILD')
        os.rename(stage, output)
        return result
    except BaseException:
        require(stage.is_dir() and not stage.is_symlink() and
                (stage.stat().st_dev, stage.stat().st_ino) == own_identity, 'OUTPUT_OWNERSHIP_CHANGED_NO_CLEANUP')
        shutil.rmtree(stage)
        raise


def unpack_release(archive, *, expected_archive_sha256, expected_manifest_sha256, output):
    """Strict file-only package reader; never extractall, links or tar permissions.

    The caller supplies the independently authenticated whole archive digest.
    A second complete digest detects input replacement while parsing/copying.
    """
    archive, output = safe_local(archive), safe_local(output)
    require(not output.exists() and output.parent.is_dir(), 'OUTPUT_EXISTS_OR_PARENT_MISSING')
    require(not archive.is_relative_to(output), 'OUTPUT_OVERLAPS_ARCHIVE')
    with regular(archive) as (stream, before):
        require(stream_copy(stream, maximum=MAX_TOTAL_BYTES)[0] == digest(expected_archive_sha256), 'ARCHIVE_SHA_MISMATCH')
    output.mkdir(mode=0o700)
    identity = (output.stat().st_dev, output.stat().st_ino)
    try:
        seen, bodies, total = set(), {}, 0
        with regular(archive) as (source, observed):
            require(fingerprint(before) == fingerprint(observed), 'ARCHIVE_CHANGED')
            with tarfile.open(fileobj=source, mode='r:*') as package:
                for member in package:
                    name = safe_name(member.name)
                    require(name not in seen and member.isfile() and not member.issparse(), 'ARCHIVE_MEMBER_NOT_UNIQUE_REGULAR')
                    require(not member.mode & 0o7000 and 0 <= member.size <= MAX_FILE_BYTES, 'ARCHIVE_MEMBER_MODE_OR_SIZE')
                    require(set(member.pax_headers) <= {'mtime', 'atime', 'ctime', 'path'}, 'ARCHIVE_PAX_UNSUPPORTED')
                    seen.add(name)
                    total += member.size
                    require(len(seen) <= MAX_FILES and total <= MAX_TOTAL_BYTES, 'ARCHIVE_LIMIT_EXCEEDED')
                    target = output / name
                    require(not any((output / p).is_file() for p in Path(name).parents if str(p) != '.'), 'ARCHIVE_PATH_COLLISION')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, output_mode(member.mode))
                    with os.fdopen(fd, 'wb') as destination, package.extractfile(member) as body:
                        hashed, size = stream_copy(body, destination)
                    require(size == member.size, 'ARCHIVE_BODY_SIZE')
                    target.chmod(output_mode(member.mode))
                    os.utime(target, ns=(FIXED_MTIME_NS, FIXED_MTIME_NS))
                    bodies[name] = hashed
                # tarfile normally stops at the first zero record and can hide
                # a concatenated archive. Require the remaining decompressed
                # stream to be only the canonical tar end/padding records.
                package.fileobj.seek(package.offset)
                padding = package.fileobj.read(10241)
                require(1024 <= len(padding) <= 10240 and not any(padding), 'ARCHIVE_TRAILING_DATA_OR_MISSING_END')
        raw = read_small(output / MANIFEST)
        manifest = validate_manifest(raw, expected_manifest_sha256)
        require(seen == set(manifest) | {MANIFEST}, 'ARCHIVE_UNDECLARED_OR_MISSING_BODY')
        require(all(bodies[name] == hashed for name, hashed in manifest.items()), 'ARCHIVE_MANIFEST_BODY_MISMATCH')
        with regular(archive) as (source, observed):
            require(fingerprint(before) == fingerprint(observed) and stream_copy(source, maximum=MAX_TOTAL_BYTES)[0] == expected_archive_sha256, 'ARCHIVE_CHANGED')
        finish_directories(output)
        return {'manifest_sha256': expected_manifest_sha256, 'archive_sha256': expected_archive_sha256,
                'files': len(manifest), 'output': str(output)}
    except BaseException:
        require(output.is_dir() and not output.is_symlink() and
                (output.stat().st_dev, output.stat().st_ino) == identity, 'OUTPUT_OWNERSHIP_CHANGED_NO_CLEANUP')
        shutil.rmtree(output)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='command', required=True)
    build = modes.add_parser('build')
    for name in ('old-root', 'new-root', 'old-manifest-sha256', 'new-manifest-sha256', 'old-inventory', 'old-inventory-sha256', 'output'):
        build.add_argument('--' + name, required=True)
    build.add_argument('--publication-epoch', type=int, required=True)
    unpack = modes.add_parser('unpack')
    for name in ('archive', 'expected-archive-sha256', 'expected-manifest-sha256', 'output'):
        unpack.add_argument('--' + name, required=True)
    args = vars(parser.parse_args(argv))
    command = args.pop('command')
    if command == 'build':
        args['old_inventory'] = read_small(args['old_inventory'])
        result = build_views(**args)
    else:
        result = unpack_release(**args)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
