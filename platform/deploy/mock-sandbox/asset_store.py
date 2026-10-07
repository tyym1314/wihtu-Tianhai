#!/usr/bin/env python3
"""Install/check/recover only the fixed, inactive Mock retained-asset store.

No Nginx activation, service command, pin, release, database or mutable conflict
change. CLI targets are fixed; relocated Store instances exist for local tests.
"""
import argparse
from contextlib import contextmanager
import fcntl
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import types

_source = Path(__file__).with_name('asset_routes.py')
routes = types.ModuleType('mock_asset_store_routes')
routes.__file__ = str(_source)
exec(compile(_source.read_bytes(), str(_source), 'exec'), routes.__dict__)
bundle = routes.bundle

STORE = Path(routes.STORE)
NAME = STORE.name
STAGE = '.stage-' + NAME
LOCK = '.asset-store.lock'
INTENT = '.asset-store-intent.json'
RECEIPT = '.asset-store-receipt.json'
PARTIAL = '.asset.pending'
# Stable file metadata: native Nginx validators must survive interrupted installs.
MTIME_NS = 1791331200 * 1000000000  # 2026-10-07T00:00:00Z, before the pinned build


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def expected_artifacts(path):
    with bundle.open_regular(path) as stream:
        raw = stream.read(bundle.MAX_BUNDLE_BYTES + 1)
    # This recomputes the exact routes from the same verified internal plan.
    generated, _route_receipt = routes.artifacts(raw)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as tar:
        plan_bytes = tar.extractfile('BUNDLE-PLAN.json').read()
        plan = bundle.json_value(plan_bytes)
        bodies = {entry['bundle_member']: tar.extractfile(entry['bundle_member']).read()
                  for entry in plan['entries']}
    directories = {'.'}
    for name in bodies:
        directories.update(str(p) for p in Path(name).parents)
    layout = {'files': [{'path': item['bundle_member'], 'sha256': item['sha256'],
                         'bytes': item['body_bytes'], 'mode': 0o444, 'mtime_ns': MTIME_NS}
                        for item in plan['entries']],
              'directories': sorted(directories), 'directory_mode': 0o555, 'root_mode': 0o755}
    intent = {
        'schema': 'mock-asset-store-intent-v1', 'store': str(STORE),
        'bundle_sha256': bundle.sha(raw), 'plan_sha256': bundle.sha(plan_bytes),
        'locations_sha256': bundle.sha(generated['locations.conf']),
        'layout_sha256': bundle.sha(bundle.encoded(layout)),
        'scope': plan['scope'], 'asset_count': plan['count'], 'asset_body_bytes': plan['body_bytes'],
        'unresolved_conflicts': plan['unresolved_conflicts'],
        'activation_performed': False, 'nginx_state': 'not-inspected', 'upgrade_allowed': False,
    }
    receipt = dict(intent, schema='mock-asset-store-receipt-v1', store_installed=True,
                   http_verified=False, apply_allowed=False)
    return {'bodies': bodies, 'directories': directories, 'intent': bundle.encoded(intent),
            'receipt': bundle.encoded(receipt), 'result': receipt}


class Store:
    """Trusted administrator filesystem transaction, never a service activator.

    Production CLI fixes parent and uid=0. Tests relocate the complete private
    transaction under an owned directory; neither override is a CLI option.
    All cooperating writers take only this lock, never service/release locks.
    """
    def __init__(self, parent=STORE.parent, owner=0):
        self.parent = bundle.safe_local_path(parent)
        self.owner = owner
        self.final = self.parent / NAME
        self.stage = self.parent / STAGE

    def checkpoint(self, _name):
        pass

    def directory(self, path, modes):
        info = path.lstat()
        bundle.require(stat.S_ISDIR(info.st_mode) and info.st_uid == self.owner
                       and stat.S_IMODE(info.st_mode) in modes, 'UNSAFE_STORE_DIRECTORY')

    def regular(self, path, modes):
        info = path.lstat()
        bundle.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                       and info.st_uid == self.owner and stat.S_IMODE(info.st_mode) in modes,
                       'UNSAFE_STORE_FILE')
        return info

    def ancestors(self):
        bundle.safe_local_path(self.parent)
        for path in self.parent.parents:
            info = path.lstat()
            bundle.require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, self.owner)
                           and not info.st_mode & 0o022, 'UNSAFE_STORE_ANCESTOR')

    @contextmanager
    def locked(self, create=False, shared=False):
        self.ancestors()
        if create and not self.parent.exists():
            self.parent.mkdir(mode=0o755)
            os.chmod(self.parent, 0o755)
            sync_dir(self.parent.parent)
        self.directory(self.parent, (0o755,))
        path = self.parent / LOCK
        if create:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                pass
            else:
                os.fsync(fd)
                os.close(fd)
                sync_dir(self.parent)
        self.regular(path, (0o600,))
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            info, current = os.fstat(fd), path.lstat()
            bundle.require((info.st_dev, info.st_ino) == (current.st_dev, current.st_ino)
                           and info.st_nlink == 1 and info.st_size == 0, 'STORE_LOCK_CHANGED')
            yield
        finally:
            os.close(fd)

    def membership(self):
        allowed = {LOCK, INTENT, RECEIPT, INTENT + '.pending', RECEIPT + '.pending', PARTIAL, STAGE, NAME}
        bundle.require({p.name for p in self.parent.iterdir()} <= allowed, 'STORE_PARENT_MEMBERS')

    def metadata(self, name, expected):
        path = self.parent / name
        self.regular(path, (0o600,))
        with bundle.open_regular(path) as stream:
            bundle.require(stream.read(len(expected) + 1) == expected, 'STORE_METADATA_MISMATCH')

    def pending_metadata(self, name, expected):
        path = self.parent / (name + '.pending')
        if path.exists() or path.is_symlink():
            self.regular(path, (0o600,))
            with bundle.open_regular(path) as stream:
                data = stream.read(len(expected) + 1)
            bundle.require(expected.startswith(data), 'STORE_PENDING_METADATA_MISMATCH')

    def write_metadata(self, name, expected):
        path, pending = self.parent / name, self.parent / (name + '.pending')
        if path.exists() or path.is_symlink():
            self.metadata(name, expected)
            return
        self.pending_metadata(name, expected)
        if pending.exists():
            pending.unlink()
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(expected)
            stream.flush()
            os.fsync(stream.fileno())
        self.checkpoint(name + '-written')
        os.rename(pending, path)
        sync_dir(self.parent)

    def validate_tree(self, root, expected, complete):
        self.directory(root, (0o755,) if complete else (0o700, 0o755))
        seen_files, seen_dirs = set(), {'.'}
        # Do not use rglob: an unexpected symlink directory must never be followed.
        def visit(directory):
            for path in directory.iterdir():
                relative = str(path.relative_to(root))
                info = path.lstat()
                if stat.S_ISDIR(info.st_mode):
                    bundle.require(relative in expected['directories'], 'STORE_EXTRA_DIRECTORY')
                    self.directory(path, (0o555,) if complete else (0o755, 0o555))
                    seen_dirs.add(relative)
                    visit(path)
                else:
                    bundle.require(relative in expected['bodies'], 'STORE_EXTRA_FILE')
                    self.regular(path, (0o444,))
                    body = expected['bodies'][relative]
                    bundle.require(info.st_size == len(body) and info.st_mtime_ns == MTIME_NS,
                                   'STORE_FILE_METADATA')
                    with bundle.open_regular(path) as stream:
                        bundle.require(stream.read(len(body) + 1) == body, 'STORE_BODY_MISMATCH')
                    seen_files.add(relative)
        visit(root)
        if complete:
            bundle.require(seen_files == set(expected['bodies']) and seen_dirs == expected['directories'],
                           'STORE_MEMBERS_MISSING')
        return seen_files

    def validate_transaction(self, expected):
        self.membership()
        for name in (INTENT, RECEIPT):
            self.pending_metadata(name, expected['intent' if name == INTENT else 'receipt'])
            if (self.parent / name).exists() or (self.parent / name).is_symlink():
                self.metadata(name, expected['intent' if name == INTENT else 'receipt'])
        intent = (self.parent / INTENT).exists()
        final = self.final.exists() or self.final.is_symlink()
        stage = self.stage.exists() or self.stage.is_symlink()
        bundle.require(not (final and stage), 'AMBIGUOUS_STORE_TREES')
        bundle.require(intent or not (final or stage or (self.parent / PARTIAL).exists()
                                      or (self.parent / RECEIPT).exists()), 'UNCLAIMED_STORE')
        if final:
            self.validate_tree(self.final, expected, True)
        if stage:
            self.validate_tree(self.stage, expected, False)
        bundle.require(not (self.parent / RECEIPT).exists() or final, 'RECEIPT_WITHOUT_STORE')
        partial = self.parent / PARTIAL
        if partial.exists() or partial.is_symlink():
            info = self.regular(partial, (0o600, 0o444))
            bundle.require(not final and intent and info.st_size <= bundle.MAX_FILE_BYTES, 'UNEXPECTED_PARTIAL_ASSET')

    def complete(self, expected):
        # Validate the entire prior transaction before any recovery mutation.
        self.validate_transaction(expected)
        self.write_metadata(INTENT, expected['intent'])
        self.checkpoint('intent-durable')
        if not self.final.exists():
            partial = self.parent / PARTIAL
            if partial.exists():
                partial.unlink()
                sync_dir(self.parent)
            if not self.stage.exists():
                self.stage.mkdir(mode=0o700)
                sync_dir(self.parent)
            self.checkpoint('stage-created')
            existing = self.validate_tree(self.stage, expected, False)
            missing = set(expected['bodies']) - existing
            if missing:
                bundle.require(stat.S_IMODE(self.stage.stat().st_mode) == 0o700, 'SEALED_STAGE_INCOMPLETE')
            for name in sorted(missing):
                target = self.stage / name
                for relative in reversed(Path(name).parents):
                    directory = self.stage / relative
                    if not directory.exists():
                        directory.mkdir(mode=0o755)
                        os.chmod(directory, 0o755)
                        sync_dir(directory.parent)
                    elif directory != self.stage:
                        self.directory(directory, (0o755,))
                fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as stream:
                    self.checkpoint('asset-opened')
                    stream.write(expected['bodies'][name])
                    stream.flush()
                    self.checkpoint('asset-written')
                    os.fchmod(stream.fileno(), 0o444)
                    os.utime(stream.fileno(), ns=(MTIME_NS, MTIME_NS))
                    os.fsync(stream.fileno())
                bundle.require(not target.exists() and not target.is_symlink(), 'STORE_ASSET_CONFLICT')
                os.rename(partial, target)
                sync_dir(target.parent)
                sync_dir(self.parent)
                self.checkpoint('asset-durable')
            self.validate_tree(self.stage, expected, False)
            for name in sorted(expected['directories'], key=lambda p: len(Path(p).parts), reverse=True):
                # macOS requires owner write permission on the renamed directory.
                # The root remains root-owned 0755; files stay sealed 0444.
                os.chmod(self.stage / name, 0o755 if name == '.' else 0o555)
                sync_dir(self.stage / name)
                self.checkpoint('directory-sealed')
            self.validate_tree(self.stage, expected, True)
            self.checkpoint('stage-sealed')
            bundle.require(not self.final.exists() and not self.final.is_symlink(), 'STORE_EXISTS')
            os.rename(self.stage, self.final)
            sync_dir(self.parent)
            self.checkpoint('store-published')
        self.validate_tree(self.final, expected, True)
        self.write_metadata(RECEIPT, expected['receipt'])
        # Only temporary metadata with verified canonical prefixes may remain.
        for name in (INTENT, RECEIPT):
            pending = self.parent / (name + '.pending')
            if pending.exists():
                pending.unlink()
        sync_dir(self.parent)
        return self.check_locked(expected)

    def check_locked(self, expected):
        self.validate_transaction(expected)
        bundle.require({p.name for p in self.parent.iterdir()} == {LOCK, INTENT, RECEIPT, NAME},
                       'STORE_INSTALL_INCOMPLETE')
        self.metadata(INTENT, expected['intent'])
        self.metadata(RECEIPT, expected['receipt'])
        self.validate_tree(self.final, expected, True)
        return dict(expected['result'], installation_path=str(self.final),
                    relocated_fixture=self.final != STORE,
                    production_store_installed=self.final == STORE and self.owner == 0)

    def install(self, source):
        expected = expected_artifacts(source)
        with self.locked(create=True):
            bundle.require({p.name for p in self.parent.iterdir()} == {LOCK}, 'EXISTING_STORE_REQUIRES_RECOVER')
            return self.complete(expected)

    def recover(self, source):
        expected = expected_artifacts(source)
        with self.locked():
            return self.complete(expected)

    def check(self, source):
        expected = expected_artifacts(source)
        with self.locked(shared=True):
            return self.check_locked(expected)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('check', 'install', 'recover'))
    parser.add_argument('--bundle', required=True)
    args = parser.parse_args(argv)
    try:
        bundle.require(os.geteuid() == 0, 'ROOT_REQUIRED')
        result = getattr(Store(), args.mode)(args.bundle)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, tarfile.TarError, UnicodeError, KeyError, TypeError):
        print(json.dumps({'verified': False, 'error': 'ASSET_STORE_REFUSED', 'apply_allowed': False,
                          'activation_performed': False, 'nginx_state': 'not-inspected', 'upgrade_allowed': False}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
