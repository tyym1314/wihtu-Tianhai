#!/usr/bin/env python3
"""Reversibly archive one of nine allowlisted inactive releases on the existing host.

The default checks all nine without writes. Mutation holds the existing deployment
lock and requires another complete protection/space/content check. Archives retain
file bytes, relative paths, POSIX ownership/modes/mtime and internal symlinks;
external links, extended attributes and special files are refused.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile

ALLOW = ('20260927-01', '20260927-02', '20260927-03', '20260928-01',
         '20260928-02', '20260928-03', '20261004-02', '20261004-03', '20261004-04')
STATIC = ('platform/dist/', 'platform/arena/dist/', 'platform/legacy/dist/',
          'platform/public/', 'platform/specs/examples/partner-host/public/')
FINGERPRINT = re.compile(r'[-.][A-Za-z0-9_-]{8,64}\.(?:js|mjs|css|png|webp|jpe?g|svg|glb|woff2?|mp3|ogg|wasm)$')
RESERVE = 3 * 1024 ** 3
STORAGE_STATES = ('retained', 'quarantine_prepared', 'quarantined', 'unlink_prepared', 'restic_only')


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def directory(path):
    require(path.is_dir() and not path.is_symlink(), 'UNSAFE_DIRECTORY')


def write_json(path, data):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(data, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def storage_state(folder, name):
    """A missing record means legacy v1; callers of v2 must require a record."""
    path = folder / 'storage.json'
    if not path.exists() and not path.is_symlink():
        return None
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o600, 'UNSAFE_STORAGE_STATE')
    data = json.loads(path.read_text())
    require(data.get('format') == 1 and data.get('release') == name and data.get('state') in STORAGE_STATES,
            'INVALID_STORAGE_STATE')
    for key in ('proof_sha256', 'repository_id', 'snapshot_id', 'archive_sha256',
                'snapshot_sha256', 'receipt_sha256', 'identity_sha256'):
        require(isinstance(data.get(key), str) and re.fullmatch(r'[a-f0-9]{64}', data[key]), 'INVALID_STORAGE_DIGEST')
    return data


def sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sync_tree(root):
    paths = [root, *sorted(root.rglob('*'))]
    for path in paths:
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
    for path in reversed(paths):
        if path.is_dir() and not path.is_symlink():
            sync_dir(path)


def available_bytes(path):
    usage = os.statvfs(path)
    return usage.f_bavail * usage.f_frsize


def allocated_bytes(root):
    values = {(path.lstat().st_dev, path.lstat().st_ino): path.lstat().st_blocks * 512
              for path in [root, *root.rglob('*')]}
    return sum(values.values())


def snapshot(root):
    directory(root)
    entries = {}
    allocated = 0
    inodes = set()
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        require(hasattr(os, 'listxattr'), 'LINUX_XATTR_INSPECTION_REQUIRED')
        require(not os.listxattr(path, follow_symlinks=False), 'EXTENDED_ATTRIBUTES_REQUIRE_SEPARATE_ARCHIVE')
        name = '.' if path == root else path.relative_to(root).as_posix()
        require(not any(part in ('private', '.local', 'backups') for part in PurePosixPath(name).parts), 'PRIVATE_PATH_IN_RELEASE')
        entry = dict(mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid,
                     mtime_ns=info.st_mtime_ns, ctime_ns=info.st_ctime_ns)
        inode = (info.st_dev, info.st_ino)
        if inode not in inodes:
            allocated += info.st_blocks * 512
            inodes.add(inode)
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            require(not os.path.isabs(target), 'ABSOLUTE_DEPENDENCY_LINK')
            require(path.resolve(strict=True).is_relative_to(root.resolve()), 'EXTERNAL_DEPENDENCY_LINK')
            entry.update(type='link', target=target)
        elif stat.S_ISDIR(info.st_mode):
            entry.update(type='directory')
        else:
            require(stat.S_ISREG(info.st_mode), 'SPECIAL_FILE_IN_RELEASE')
            entry.update(type='file', size=info.st_size, sha256=digest(path))
            after = path.lstat()
            require((info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino) ==
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_ino), 'SOURCE_CHANGED_DURING_READ')
        entries[name] = entry
    return dict(format=1, entries=entries, allocated_bytes=allocated, external_dependencies=[])


def content(snapshot_data):
    return {name: {key: value for key, value in entry.items() if key != 'ctime_ns'}
            for name, entry in snapshot_data['entries'].items()}


def verify_manifest(root, snapshot_data):
    path = root / 'RELEASE-MANIFEST.json'
    require(path.is_file() and not path.is_symlink(), 'RELEASE_MANIFEST_MISSING')
    data = json.loads(path.read_text())
    files = data.get('files', data)
    require(isinstance(files, dict) and bool(files), 'INVALID_RELEASE_MANIFEST')
    for name, expected in files.items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and relative.as_posix() == name, 'UNSAFE_MANIFEST_PATH')
        require(re.fullmatch(r'[a-f0-9]{64}', str(expected)), 'INVALID_MANIFEST_HASH')
        entry = snapshot_data['entries'].get(name, {})
        require(entry.get('type') == 'file' and entry.get('sha256') == expected, 'RELEASE_MANIFEST_MISMATCH')
    return files


def space_bounds(snapshot_data):
    entries = snapshot_data['entries'].values()
    tar_upper = 10240 + sum(8192 + (math.ceil(item.get('size', 0) / 512) * 512) for item in entries)
    archive_upper = tar_upper + math.ceil(tar_upper / 1000) + 65536
    restore_upper = sum(4096 + math.ceil(item.get('size', 0) / 4096) * 4096 for item in entries)
    metadata_upper = len(json.dumps(snapshot_data, sort_keys=True, indent=2).encode('utf-8')) + 1024 * 1024
    return dict(archive_conservative_upper_bytes=archive_upper, extraction_upper_bytes=restore_upper,
                metadata_upper_bytes=metadata_upper, temporary_required_bytes=archive_upper + restore_upper + metadata_upper,
                minimum_remaining_bytes=RESERVE)


class Archiver:
    def __init__(self, base=Path('/opt/oasis'), proc=Path('/proc'), reserve=RESERVE):
        self.base, self.proc, self.reserve = Path(base), Path(proc), reserve
        self.releases, self.archives = self.base / 'releases', self.base / 'release-archives'

    def paths(self, name):
        require(name in ALLOW, 'RELEASE_NOT_ALLOWLISTED')
        return self.releases / name, self.archives / ('.work-' + name), self.archives / name

    def protection(self):
        directory(self.base)
        directory(self.releases)
        directory(self.proc)
        protected = set()
        pins = {}
        for name in ('current', 'android-mock-current'):
            link = self.base / name
            require(link.is_symlink(), 'RELEASE_PIN_MISSING')
            target = link.resolve(strict=True)
            require(target.parent == self.releases and re.fullmatch(r'\d{8}-\d{2}', target.name), 'RELEASE_PIN_OUTSIDE_ROOT')
            protected.add(target.name)
            pins[name] = target.name
        last_path = self.base / 'private/last-release.json'
        require(last_path.is_file() and not last_path.is_symlink(), 'RELEASE_STATE_UNSAFE')
        last = json.loads(last_path.read_text())
        require(last.get('current') == str(self.releases / pins['current']), 'RELEASE_STATE_PIN_MISMATCH')
        previous = Path(last.get('previous', ''))
        require(previous.parent == self.releases and re.fullmatch(r'\d{8}-\d{2}', previous.name), 'PREVIOUS_RELEASE_UNSAFE')
        protected.add(previous.name)
        newest = sorted((path.name for path in self.releases.iterdir()
                         if path.is_dir() and not path.is_symlink() and re.fullmatch(r'\d{8}-\d{2}', path.name)
                         and path.name not in set(pins.values())), reverse=True)[:3]
        protected.update(newest)
        references = {}
        pattern = re.compile(re.escape(str(self.releases)) + r'/(\d{8}-\d{2})(?![A-Za-z0-9_-])')
        for process in self.proc.iterdir():
            if not process.name.isdigit():
                continue
            values = []
            for item in ('cwd', 'exe'):
                try:
                    values.append(os.readlink(process / item))
                except FileNotFoundError:
                    pass
            for item in ('cmdline', 'maps'):
                try:
                    values.append((process / item).read_bytes().replace(b'\0', b' ').decode(errors='replace'))
                except FileNotFoundError:
                    require(not process.exists(), 'PROCESS_STATE_UNREADABLE')
            try:
                descriptors = list((process / 'fd').iterdir())
            except FileNotFoundError:
                require(not process.exists(), 'PROCESS_FDS_UNREADABLE')
                descriptors = []
            for descriptor in descriptors:
                try:
                    values.append(os.readlink(descriptor))
                except FileNotFoundError:
                    pass
            found = sorted(set(match for value in values for match in pattern.findall(value)))
            if found:
                references[process.name] = found
                protected.update(found)
        return dict(pins=pins, previous=previous.name, recent_retained=newest,
                    process_references=references, protected=sorted(protected))

    def eligible(self, name):
        result = self.protection()
        require(name not in result['protected'], 'RELEASE_IS_PROTECTED')
        return result

    def coverage(self, snapshot_data):
        current = (self.base / 'current').resolve(strict=True)
        checked = 0
        for name, entry in snapshot_data['entries'].items():
            if entry['type'] != 'file' or not name.startswith(STATIC) or not FINGERPRINT.search(name):
                continue
            path = current / name
            require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(current), 'CURRENT_STATIC_ASSET_MISSING')
            require(digest(path) == entry['sha256'], 'CURRENT_STATIC_ASSET_HASH_MISMATCH')
            checked += 1
        return checked

    def check(self, name):
        source, work, final = self.paths(name)
        protection = self.eligible(name)
        require(not work.exists() and not work.is_symlink(), 'INTERRUPTED_ARCHIVE_REQUIRES_RECOVER')
        require(not final.exists() and not final.is_symlink(), 'EXISTING_ARCHIVE_REQUIRES_INSPECTION')
        before = snapshot(source)
        verify_manifest(source, before)
        coverage = self.coverage(before)
        bounds = space_bounds(before)
        bounds['minimum_remaining_bytes'] = self.reserve
        available = available_bytes(self.base)
        require(available >= bounds['temporary_required_bytes'] + self.reserve, 'INSUFFICIENT_TEMPORARY_SPACE')
        return dict(release=name, source=str(source), archive=str(final / 'release.tar.gz'), protection=protection,
                    files=len(before['entries']), allocated_bytes=before['allocated_bytes'], static_fingerprints_verified=coverage,
                    external_dependencies=before['external_dependencies'], available_bytes=available, **bounds), before

    @contextmanager
    def locked(self):
        lock = self.base / 'private/release.lock'
        descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        archive_descriptor = None
        try:
            require(stat.S_ISREG(os.fstat(descriptor).st_mode), 'UNSAFE_RELEASE_LOCK')
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(os.fstat(descriptor).st_ino == lock.stat().st_ino, 'RELEASE_LOCK_REPLACED')
            if not self.archives.exists():
                self.archives.mkdir(mode=0o700)
                sync_dir(self.base)
            directory(self.archives)
            require(stat.S_IMODE(self.archives.stat().st_mode) == 0o700, 'UNSAFE_ARCHIVE_DIRECTORY')
            archive_descriptor = os.open(self.archives / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            fcntl.flock(archive_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(self.releases.stat().st_dev == self.archives.stat().st_dev, 'ARCHIVE_MUST_SHARE_FILESYSTEM')
            yield
        finally:
            if archive_descriptor is not None:
                os.close(archive_descriptor)
            os.close(descriptor)

    def archive_identity(self, folder, name):
        directory(folder)
        require(stat.S_IMODE(folder.stat().st_mode) == 0o700, 'UNSAFE_ARCHIVE_DIRECTORY')
        path = folder / 'identity.json'
        require(path.is_file() and not path.is_symlink(), 'UNSAFE_ARCHIVE_FILE')
        require(json.loads(path.read_text()) == dict(format=1, release=name), 'ARCHIVE_IDENTITY_MISMATCH')

    def archive_metadata(self, folder, name):
        self.archive_identity(folder, name)
        for filename in ('identity.json', 'snapshot.json', 'receipt.json'):
            path = folder / filename
            require(path.is_file() and not path.is_symlink(), 'UNSAFE_ARCHIVE_FILE')
        data = json.loads((folder / 'snapshot.json').read_text())
        receipt = json.loads((folder / 'receipt.json').read_text())
        require(receipt.get('release') == name and receipt.get('format') == 1, 'ARCHIVE_RECEIPT_INVALID')
        require(digest(folder / 'snapshot.json') == receipt['snapshot_sha256'], 'ARCHIVE_SNAPSHOT_MISMATCH')
        return data

    def archive_data(self, folder, name):
        state = storage_state(folder, name)
        require(not state or state['state'] == 'retained', 'ARCHIVE_STORAGE_REQUIRES_RESTIC_OR_RECOVERY')
        data = self.archive_metadata(folder, name)
        path = folder / 'release.tar.gz'
        require(path.is_file() and not path.is_symlink(), 'UNSAFE_ARCHIVE_FILE')
        receipt = json.loads((folder / 'receipt.json').read_text())
        require(digest(folder / 'release.tar.gz') == receipt['archive_sha256'], 'ARCHIVE_HASH_MISMATCH')
        return data

    def unpack(self, folder, target, name):
        data = self.archive_data(folder, name)
        require(available_bytes(self.base) >= space_bounds(data)['extraction_upper_bytes'] + self.reserve, 'INSUFFICIENT_RESTORE_SPACE')
        require(not target.exists(), 'RESTORE_DESTINATION_EXISTS')
        target.mkdir(mode=0o700)
        expected = {name + ('' if relative == '.' else '/' + relative): entry for relative, entry in data['entries'].items()}
        with tarfile.open(folder / 'release.tar.gz', 'r:gz') as archive:
            members = archive.getmembers()
            require(len(members) == len(expected) and set(item.name for item in members) == set(expected), 'ARCHIVE_ENTRY_SET_MISMATCH')
            links = []
            for item in members:
                relative = PurePosixPath(item.name)
                require(not relative.is_absolute() and '..' not in relative.parts and relative.as_posix() == item.name, 'UNSAFE_ARCHIVE_PATH')
                entry = expected[item.name]
                require((item.mode, item.uid, item.gid) == (entry['mode'], entry['uid'], entry['gid']), 'ARCHIVE_METADATA_MISMATCH')
                path = target / item.name
                if item.isdir():
                    require(entry['type'] == 'directory', 'ARCHIVE_TYPE_MISMATCH')
                    path.mkdir(mode=0o700)
                elif item.isfile():
                    require(entry['type'] == 'file' and item.size == entry['size'], 'ARCHIVE_TYPE_MISMATCH')
                    with path.open('xb') as output, archive.extractfile(item) as source:
                        shutil.copyfileobj(source, output)
                else:
                    require(item.issym() and entry['type'] == 'link' and item.linkname == entry['target'], 'UNSAFE_ARCHIVE_LINK')
                    links.append((path, item.linkname))
            for path, link in links:
                require(not os.path.isabs(link) and (path.parent / link).resolve().is_relative_to(target / name), 'EXTERNAL_ARCHIVE_LINK')
                path.symlink_to(link)
        for relative, entry in reversed(list(data['entries'].items())):
            path = target / name if relative == '.' else target / name / relative
            os.chown(path, entry['uid'], entry['gid'], follow_symlinks=False)
            if entry['type'] != 'link':
                path.chmod(entry['mode'])
            os.utime(path, ns=(entry['mtime_ns'], entry['mtime_ns']), follow_symlinks=False)
        restored = snapshot(target / name)
        require(content(restored) == content(data), 'RESTORED_TREE_MISMATCH')
        verify_manifest(target / name, restored)
        return data

    def archive(self, name):
        source, work, final = self.paths(name)
        with self.locked():
            report, before = self.check(name)
            work.mkdir(mode=0o700)
            try:
                write_json(work / 'identity.json', dict(format=1, release=name))
                write_json(work / 'snapshot.json', before)
                with tarfile.open(work / 'release.tar.gz', 'w:gz', compresslevel=1, format=tarfile.PAX_FORMAT, dereference=False) as archive:
                    for relative in before['entries']:
                        path = source if relative == '.' else source / relative
                        info = archive.gettarinfo(str(path), arcname=name + ('' if relative == '.' else '/' + relative))
                        if info.islnk():
                            info.type, info.linkname, info.size = tarfile.REGTYPE, '', before['entries'][relative]['size']
                        if info.isfile():
                            with path.open('rb') as stream:
                                archive.addfile(info, stream)
                        else:
                            archive.addfile(info)
                with (work / 'release.tar.gz').open('rb') as stream:
                    os.fsync(stream.fileno())
                write_json(work / 'receipt.json', dict(format=1, release=name, archive_sha256=digest(work / 'release.tar.gz'), snapshot_sha256=digest(work / 'snapshot.json')))
                self.unpack(work, work / 'verification', name)
                self.eligible(name)
                require(snapshot(source) == before, 'SOURCE_CHANGED_DURING_ARCHIVE')
                self.coverage(before)
                shutil.rmtree(work / 'verification')
                require(allocated_bytes(work) < before['allocated_bytes'], 'ARCHIVE_HAS_NO_SPACE_SAVING')
                sync_dir(work)
                sync_dir(self.archives)
                source.rename(work / 'original')
                sync_dir(work)
                sync_dir(self.releases)
                require(content(snapshot(work / 'original')) == content(before), 'QUARANTINE_TREE_CHANGED')
                self.eligible(name)
                self.coverage(before)
                require(not final.exists(), 'ARCHIVE_DESTINATION_EXISTS')
                work.rename(final)
                sync_dir(self.archives)
                sync_dir(final)
                shutil.rmtree(final / 'original')
                sync_dir(final)
                return dict(status='archived', release=name, archive=str(final / 'release.tar.gz'),
                            original_allocated_bytes=before['allocated_bytes'], archive_bytes=(final / 'release.tar.gz').stat().st_size,
                            archive_allocated_bytes=allocated_bytes(final),
                            reclaimed_bytes=before['allocated_bytes'] - allocated_bytes(final))
            except BaseException:
                if work.exists():
                    if (work / 'original').exists() and not source.exists():
                        (work / 'original').rename(source)
                        sync_dir(self.releases)
                        sync_dir(work)
                    if source.exists():
                        shutil.rmtree(work)
                raise

    def finish_recovery(self, folder, work):
        for child in ('recovery', 'original'):
            path = folder / child
            if path.exists() or path.is_symlink():
                directory(path)
                shutil.rmtree(path)
        (folder / 'restore-in-progress.json').unlink(missing_ok=True)
        sync_dir(folder)
        if folder == work:
            shutil.rmtree(work)
            sync_dir(self.archives)

    def recover(self, name, restore=False):
        source, work, final = self.paths(name)
        with self.locked():
            self.eligible(name)
            require(not (work.exists() and final.exists()), 'AMBIGUOUS_ARCHIVE_STATE')
            folder = work if work.exists() else final
            self.archive_identity(folder, name)
            state = storage_state(folder, name)
            if state and state['state'] != 'retained':
                return dict(status='ARCHIVE_MOVED_TO_RESTIC' if state['state'] == 'restic_only' else 'ARCHIVE_RETIREMENT_IN_PROGRESS',
                            release=name, storage_state=state['state'], restored=False,
                            next_command=('python3 compact-release-archives.py --restore ' + name) if state['state'] == 'restic_only'
                            else ('python3 retire-release-archives.py --recover ' + name))
            marker = folder / 'restore-in-progress.json'
            if folder == work and source.exists() and not (work / 'original').exists() and not marker.exists():
                sync_tree(source)
                sync_dir(self.releases)
                shutil.rmtree(work)
                sync_dir(self.archives)
                return dict(status='preparation_rolled_back', release=name)
            if marker.exists() or marker.is_symlink():
                require(marker.is_file() and not marker.is_symlink(), 'UNSAFE_RESTORE_MARKER')
                require(json.loads(marker.read_text()) == dict(format=1, release=name), 'INVALID_RESTORE_MARKER')
            if source.exists():
                require(marker.exists(), 'RESTORE_WOULD_OVERWRITE_RELEASE')
                before = self.archive_data(folder, name)
                require(content(snapshot(source)) == content(before), 'RESTORED_SOURCE_CHANGED')
                self.coverage(before)
                sync_tree(source)
                sync_dir(self.releases)
                self.finish_recovery(folder, work)
                return dict(status='restore_cleanup_completed', release=name, source=str(source))
            if folder == final and not (final / 'original').exists() and not restore and not marker.exists():
                self.archive_data(final, name)
                return dict(status='already_archived', release=name)
            if not marker.exists():
                write_json(marker, dict(format=1, release=name))
                sync_dir(folder)
            target = folder / 'recovery'
            if target.exists():
                directory(target)
                shutil.rmtree(target)
            before = self.unpack(folder, target, name)
            self.eligible(name)
            self.coverage(before)
            sync_tree(target / name)
            sync_dir(target)
            (target / name).rename(source)
            sync_dir(self.releases)
            sync_dir(target)
            self.finish_recovery(folder, work)
            return dict(status='restored', release=name, source=str(source))


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Run check-only again after any activation. Archive one release, inspect its measured reclaimed_bytes, then recheck before another. --recover rolls back interrupted work; --restore explicitly restores a completed archive. Existing archives and release directories are never overwritten.')
    parser.add_argument('release', nargs='?', choices=ALLOW, help='Exactly one allowlisted release for mutation; omit only for check-only')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check-only', action='store_true', help='Read-only observation, no locks or files created (default)')
    modes.add_argument('--archive', action='store_true', help='Compress, really extract and verify, quarantine, then reclaim one original')
    modes.add_argument('--recover', action='store_true', help='Safely recover an interrupted transaction for one release')
    modes.add_argument('--restore', action='store_true', help='Restore one completed archive while retaining its archive copy')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    task = Archiver()
    if args.archive or args.recover or args.restore:
        require(args.release, 'EXACTLY_ONE_RELEASE_REQUIRED')
        result = task.archive(args.release) if args.archive else task.recover(args.release, restore=args.restore)
    else:
        result = {'mode': 'check-only', 'releases': [task.check(name)[0] for name in ([args.release] if args.release else ALLOW)]}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, tarfile.TarError) as error:
        raise SystemExit('ARCHIVE_REFUSED: ' + str(error))
