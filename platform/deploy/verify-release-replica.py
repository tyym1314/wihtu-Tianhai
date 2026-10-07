#!/usr/bin/env python3
"""Verify an independent USTAR Restic export in a new Linux directory.

No deployment state, original archive, or original repository is consulted. The
password is a separate owned 0600 input; it is never copied into the export or
report. Requires this script's sibling archive-releases.py (pure helpers only).
Success validates recovery, not permission to retire either recovery copy.

CLI: --bundle FILE --expected-sha256 SHA --expected-bytes N
     --password-file FILE --binary FILE --output-root NEW_ABSOLUTE_DIRECTORY
The caller must obtain SHA/bytes from its separately retained export receipt.
Interrupted output roots are never resumed or overwritten: inspect the retained
report and use another new root. No deployment lock is needed for this isolated
copy; this verifier never acquires or impersonates the original deployment lock.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import re
import secrets
import shutil
import stat
import subprocess
import tarfile
import time

SPEC = importlib.util.spec_from_file_location('replica_archive_helpers', Path(__file__).with_name('archive-releases.py'))
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)
require = archive.require
VERSION = '0.19.1'
BINARY_SHA256 = '20d4142678d0d95ec11a4759def1b73fd9190abc9ca19e4b62d067c0b387e639'
BINARY_BYTES = 30941346
OVERHEAD = 128 * 1024 ** 2
MAX_METADATA = 64 * 1024 ** 2
MAX_MEMBERS = 100000
HEX = re.compile(r'[a-f0-9]{64}')
ALLOW = archive.ALLOW


def sha(value):
    return hashlib.sha256(value).hexdigest()


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse_json(value):
    require(len(value) <= MAX_METADATA, 'METADATA_TOO_LARGE')
    return json.loads(value, object_pairs_hook=object_pairs)


def stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def path_name(name, root=False):
    require(isinstance(name, str) and bool(name) and not any(ord(char) < 32 for char in name)
            and '\\' not in name, 'UNSAFE_PATH')
    if name == '.' and root:
        return name
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and '.' not in path.parts
            and path.as_posix() == name and name != '.', 'UNSAFE_PATH')
    return name


def regular_fd(path, secret=False):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'UNSAFE_INPUT_FILE')
        if secret:
            require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600
                    and 32 <= info.st_size <= 1024, 'UNSAFE_PASSWORD_FILE')
        return os.fdopen(descriptor, 'rb')
    except BaseException:
        os.close(descriptor)
        raise


def fingerprint(stream):
    info = os.fstat(stream.fileno())
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def stream_hash(stream):
    stream.seek(0)
    result = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(block)
    stream.seek(0)
    return result.hexdigest()


def repo_path(name, directory):
    parts = name.split('/')
    if name in ('index.json', 'identity.json'):
        return not directory
    if name == 'repo':
        return directory
    if len(parts) < 2 or parts[0] != 'repo':
        return False
    if parts[1] == 'config':
        return len(parts) == 2 and not directory
    if parts[1] not in ('data', 'index', 'keys', 'locks', 'snapshots'):
        return False
    if len(parts) == 2:
        return directory
    if parts[1] == 'data':
        return ((len(parts) == 3 and directory and re.fullmatch(r'[a-f0-9]{2}', parts[2]) is not None)
                or (len(parts) == 4 and not directory and HEX.fullmatch(parts[3]) is not None
                    and parts[2] == parts[3][:2]))
    return len(parts) == 3 and not directory and parts[1] != 'locks' and HEX.fullmatch(parts[2]) is not None


def tar_members(stream, total_bytes):
    """Inspect every physical USTAR header, including the end/trailing blocks.

    tarfile's automatic PAX/GNU handling and extractall are deliberately unused.
    Only unique regular files/directories in the fixed export layout are accepted.
    """
    require(total_bytes >= 1024 and total_bytes % 512 == 0, 'INVALID_USTAR_SIZE')
    result, seen, position = [], {}, 0
    while position < total_bytes:
        stream.seek(position)
        block = stream.read(512)
        require(len(block) == 512, 'TRUNCATED_USTAR')
        if block == bytes(512):
            require(stream.read(512) == bytes(512), 'USTAR_END_BLOCK_MISSING')
            while True:
                tail = stream.read(1024 * 1024)
                if not tail:
                    break
                require(not any(tail), 'USTAR_TRAILING_DATA')
            break
        require(block[257:263] == b'ustar\0' and block[263:265] == b'00', 'USTAR_FORMAT_REQUIRED')
        for start, end in ((100, 108), (108, 116), (116, 124), (124, 136), (136, 148),
                           (148, 156), (329, 337), (337, 345)):
            require(all(value in b'01234567 \0' for value in block[start:end]), 'USTAR_OCTAL_FIELD_REQUIRED')
        try:
            item = tarfile.TarInfo.frombuf(block, 'utf-8', 'strict')
        except (tarfile.HeaderError, UnicodeError, ValueError):
            raise ValueError('INVALID_USTAR_HEADER') from None
        require(item.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE), 'USTAR_SPECIAL_MEMBER')
        require(not item.linkname and item.size >= 0 and not item.pax_headers, 'UNSAFE_USTAR_MEMBER')
        directory = item.type == tarfile.DIRTYPE
        name = item.name[:-1] if directory and item.name.endswith('/') else item.name
        path_name(name)
        require(repo_path(name, directory), 'UNEXPECTED_EXPORT_MEMBER')
        require(name not in seen, 'DUPLICATE_USTAR_PATH')
        require(not directory or item.size == 0, 'DIRECTORY_HAS_PAYLOAD')
        require(name not in ('index.json', 'identity.json') or item.size <= MAX_METADATA, 'METADATA_TOO_LARGE')
        end = position + 512 + ((item.size + 511) // 512) * 512
        require(end + 1024 <= total_bytes, 'TRUNCATED_USTAR')
        stream.seek(position + 512 + item.size)
        require(not any(stream.read(end - (position + 512 + item.size))), 'USTAR_NONZERO_PADDING')
        row = dict(name=name, directory=directory, size=item.size, offset=position + 512)
        result.append(row)
        seen[name] = row
        require(len(result) <= MAX_MEMBERS, 'TOO_MANY_EXPORT_MEMBERS')
        position = end
    else:
        raise ValueError('USTAR_END_BLOCK_MISSING')
    require({'repo', 'repo/config', 'index.json', 'identity.json'}.issubset(seen), 'EXPORT_ROOT_INCOMPLETE')
    for row in result:
        for parent in PurePosixPath(row['name']).parents:
            if str(parent) != '.':
                require(str(parent) in seen and seen[str(parent)]['directory'], 'EXPORT_PARENT_MISSING')
    return result


def validate_index(data):
    require(isinstance(data, dict) and data.get('format') == 1 and data.get('restic_version') == VERSION
            and data.get('original_tar_policy') == 'retained', 'INVALID_REPLICA_INDEX')
    require(isinstance(data.get('repository_id'), str) and HEX.fullmatch(data['repository_id']), 'INVALID_REPOSITORY_ID')
    entries = data.get('entries')
    require(isinstance(entries, dict) and set(entries) == set(ALLOW), 'EXACT_NINE_RELEASES_REQUIRED')
    ids = set()
    for name, row in entries.items():
        require(isinstance(row, dict) and row.get('release') == name and row.get('status') == 'verified', 'INVALID_INDEX_ENTRY')
        for key in ('snapshot_id', 'snapshot_sha256', 'receipt_sha256', 'identity_sha256', 'archive_sha256'):
            require(isinstance(row.get(key), str) and HEX.fullmatch(row[key]), 'INVALID_INDEX_DIGEST')
        require(integer(row.get('restore_upper_bytes'), 1), 'INVALID_RESTORE_BOUND')
        require(row['snapshot_id'] not in ids, 'DUPLICATE_SNAPSHOT_ID')
        ids.add(row['snapshot_id'])
    return data


def validate_snapshot(data):
    require(isinstance(data, dict) and data.get('format') == 1 and data.get('external_dependencies') == [], 'INVALID_ARCHIVE_SNAPSHOT')
    entries = data.get('entries')
    require(isinstance(entries, dict) and 1 <= len(entries) <= MAX_MEMBERS, 'INVALID_SNAPSHOT_ENTRIES')
    base = {'type', 'mode', 'uid', 'gid', 'mtime_ns', 'ctime_ns'}
    for name, row in entries.items():
        path_name(name, root=True)
        require(isinstance(row, dict), 'INVALID_SNAPSHOT_ENTRY')
        kind = row.get('type')
        extra = {'file': {'size', 'sha256'}, 'directory': set(), 'link': {'target'}}
        require(kind in extra and set(row) == base | extra[kind], 'INVALID_SNAPSHOT_FIELDS')
        require(all(integer(row.get(key)) for key in ('mode', 'uid', 'gid', 'mtime_ns', 'ctime_ns'))
                and row['mode'] <= 0o7777 and row['uid'] < 2**32 and row['gid'] < 2**32, 'INVALID_SNAPSHOT_METADATA')
        if kind == 'file':
            require(integer(row['size']) and isinstance(row['sha256'], str) and HEX.fullmatch(row['sha256']), 'INVALID_SNAPSHOT_FILE')
        elif kind == 'link':
            target = row['target']
            require(isinstance(target, str) and target and not target.startswith('/') and '\x00' not in target
                    and '\\' not in target, 'UNSAFE_SNAPSHOT_LINK')
        for parent in PurePosixPath(name).parents:
            require(entries.get(str(parent), {}).get('type') == 'directory', 'UNSAFE_SNAPSHOT_PARENT')
    require(entries.get('.', {}).get('type') == 'directory'
            and entries.get('RELEASE-MANIFEST.json', {}).get('type') == 'file', 'INVALID_SNAPSHOT_ROOT')
    # Resolve links against metadata before permitting Restic to create them.
    def resolve(name, visited):
        require(name in entries and name not in visited, 'UNSAFE_SNAPSHOT_LINK')
        row = entries[name]
        if row['type'] != 'link':
            return name
        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), row['target']))
        require(target != '..' and not target.startswith('../') and not target.startswith('/'), 'UNSAFE_SNAPSHOT_LINK')
        parts = target.split('/')
        for i in range(1, len(parts)):
            prefix = '/'.join(parts[:i])
            if entries.get(prefix, {}).get('type') == 'link':
                target = posixpath.join(resolve(prefix, visited | {name}), *parts[i:])
                break
        return resolve(target, visited | {name})
    for name, row in entries.items():
        if row['type'] == 'link':
            resolve(name, set())
    return data


class ReplicaVerifier:
    def __init__(self, bundle, expected_sha256, expected_bytes, password_file, binary, output_root):
        self.bundle_input, self.password_input, self.binary_input = map(Path, (bundle, password_file, binary))
        self.expected_sha, self.expected_bytes = expected_sha256, expected_bytes
        self.root_input = Path(output_root)
        require(not self.root_input.is_relative_to('/opt/oasis'), 'ORIGINAL_PLATFORM_PATH_FORBIDDEN')
        self.root = self.root_input.parent.resolve(strict=True) / self.root_input.name
        self.created = False
        self.report = {'format': 1, 'purpose': 'independent-release-replica-verification', 'status': 'started',
                       'run_id': secrets.token_hex(16), 'started_at_utc': stamp(), 'releases': [],
                       'reserve_bytes': archive.RESERVE, 'original_tars_modified': False,
                       'original_repository_consulted': False, 'published': False}
        self.password_stream = None

    def space(self, extra=0):
        available = archive.available_bytes(self.root if self.created else self.root.parent)
        require(available >= archive.RESERVE + extra, 'INSUFFICIENT_REPLICA_SPACE')
        return available

    def journal(self, phase):
        self.report['phase'] = phase
        self.report['updated_at_utc'] = stamp()
        target, temporary = self.root / 'report.json', self.root / '.report-next.json'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write((json.dumps(self.report, indent=2, sort_keys=True) + '\n').encode())
            output.flush()
            os.fsync(output.fileno())
        if target.exists() or target.is_symlink():
            require(stat.S_ISREG(target.lstat().st_mode) and not target.is_symlink(), 'UNSAFE_REPORT_PATH')
        os.replace(temporary, target)
        archive.sync_dir(self.root)

    def paths(self):
        require(self.root_input.is_absolute(), 'ABSOLUTE_OUTPUT_ROOT_REQUIRED')
        require(self.root != Path('/') and not self.root.is_relative_to('/opt/oasis'), 'ORIGINAL_PLATFORM_PATH_FORBIDDEN')
        require(not self.root.exists() and not self.root.is_symlink(), 'OUTPUT_ROOT_ALREADY_EXISTS')
        paths = []
        for candidate in (self.bundle_input, self.password_input, self.binary_input):
            require(not candidate.is_relative_to('/opt/oasis'), 'ORIGINAL_PLATFORM_PATH_FORBIDDEN')
            require(candidate.is_absolute() and not candidate.is_symlink(), 'UNSAFE_INPUT_PATH')
            resolved = candidate.resolve(strict=True)
            require(not resolved.is_relative_to('/opt/oasis') and not resolved.is_relative_to(self.root), 'ORIGINAL_PLATFORM_PATH_FORBIDDEN')
            paths.append(resolved)
        require(len(set(paths)) == 3, 'INPUT_PATHS_MUST_DIFFER')
        self.bundle, self.password, self.input_binary = paths

    def extract(self, stream, members):
        block = max(4096, os.statvfs(self.root).f_frsize)
        upper = sum(block + ((row['size'] + block - 1) // block) * block for row in members)
        self.space(upper + OVERHEAD)
        for row in sorted(members, key=lambda item: (not item['directory'], item['name'].count('/'), item['name'])):
            self.space(((row['size'] + block - 1) // block) * block + block)
            target = self.root / 'export' / row['name']
            if row['directory']:
                target.mkdir(mode=0o700)
                continue
            stream.seek(row['offset'])
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            remaining = row['size']
            with os.fdopen(descriptor, 'wb') as output:
                while remaining:
                    data = stream.read(min(remaining, 1024 * 1024))
                    require(data, 'TRUNCATED_USTAR')
                    self.space(len(data) + block)
                    output.write(data)
                    remaining -= len(data)
                output.flush()
                os.fsync(output.fileno())
        archive.sync_tree(self.root / 'export')

    def restic(self, *args):
        self.space(OVERHEAD)
        command = [str(self.root / 'restic'), '--repo', str(self.root / 'export/repo'),
                   '--password-file', '/proc/self/fd/' + str(self.password_stream.fileno()), '--no-cache', '--json', *args]
        result = subprocess.run(command, cwd=self.root, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                                'TMPDIR': str(self.root / 'scratch'), 'GOMAXPROCS': '2'}, capture_output=True,
                                pass_fds=(self.password_stream.fileno(),), timeout=3600)
        self.space()
        # Never report stdout/stderr on error: neither credentials nor repository contents belong in an error report.
        require(result.returncode == 0, 'RESTIC_COMMAND_FAILED_' + args[0].upper())
        require(len(result.stdout) <= MAX_METADATA, 'RESTIC_OUTPUT_TOO_LARGE')
        return result.stdout

    def metadata(self, entry):
        values = {}
        for name in ('snapshot', 'identity', 'receipt'):
            raw = self.restic('dump', entry['snapshot_id'], '/archive-metadata/' + name + '.json')
            require(sha(raw) == entry[name + '_sha256'], 'RESTORE_METADATA_HASH_MISMATCH')
            values[name] = parse_json(raw)
        require(values['identity'] == dict(format=1, release=entry['release']), 'ARCHIVE_IDENTITY_MISMATCH')
        require(values['receipt'] == dict(format=1, release=entry['release'], archive_sha256=entry['archive_sha256'],
                                        snapshot_sha256=entry['snapshot_sha256']), 'ARCHIVE_RECEIPT_MISMATCH')
        data = validate_snapshot(values['snapshot'])
        require(archive.space_bounds(data)['extraction_upper_bytes'] == entry['restore_upper_bytes'], 'RESTORE_SPACE_BOUND_MISMATCH')
        return data

    def restore(self, entry, expected):
        name = entry['release']
        target = self.root / 'restored' / name
        require(not target.exists() and not target.is_symlink(), 'RESTORE_TARGET_ALREADY_EXISTS')
        block = max(4096, os.statvfs(self.root).f_frsize)
        upper = sum(block + ((row.get('size', 0) + block - 1) // block) * block for row in expected['entries'].values())
        self.space(upper + MAX_METADATA * 3 + OVERHEAD)
        self.report['active_release'] = name
        self.journal('restoring')
        self.restic('restore', entry['snapshot_id'], '--target', str(target))
        archive.directory(target)
        require(set(path.name for path in target.iterdir()) == {name, 'archive-metadata'}, 'RESTORE_ROOT_MISMATCH')
        metadata = target / 'archive-metadata'
        archive.directory(metadata)
        require(set(path.name for path in metadata.iterdir()) == {'identity.json', 'snapshot.json', 'receipt.json'}, 'RESTORE_METADATA_SET_MISMATCH')
        for item in ('snapshot', 'receipt', 'identity'):
            path = metadata / (item + '.json')
            with regular_fd(path) as stream:
                require(stream_hash(stream) == entry[item + '_sha256'], 'RESTORED_METADATA_HASH_MISMATCH')
        actual = archive.snapshot(target / name)
        require(archive.content(actual) == archive.content(expected), 'RESTORED_TREE_MISMATCH')
        files = archive.verify_manifest(target / name, actual)
        self.report['releases'].append({key: entry[key] for key in ('release', 'snapshot_id', 'snapshot_sha256', 'receipt_sha256', 'identity_sha256', 'archive_sha256')}
                                      | dict(status='verified', entries=len(actual['entries']), manifest_files=len(files),
                                             verified_at_utc=stamp(), temporary_restore_removed=False))
        self.journal('verified_before_cleanup')
        # Only this run's exact, fully compared target is eligible for deletion.
        require(target.parent == self.root / 'restored' and not target.is_symlink(), 'UNSAFE_CLEANUP_TARGET')
        shutil.rmtree(target)
        archive.sync_dir(target.parent)
        self.report['releases'][-1]['temporary_restore_removed'] = True
        self.journal('restore_cleaned')
        self.space()

    def run(self):
        self.paths()
        require(isinstance(self.expected_sha, str) and HEX.fullmatch(self.expected_sha), 'INVALID_EXPECTED_BUNDLE_SHA256')
        require(integer(self.expected_bytes, 1024), 'INVALID_EXPECTED_BUNDLE_BYTES')
        with regular_fd(self.bundle) as bundle, regular_fd(self.password, secret=True) as password, regular_fd(self.input_binary) as binary:
            self.password_stream = password
            before = [fingerprint(stream) for stream in (bundle, password, binary)]
            require(before[0][2] == self.expected_bytes and stream_hash(bundle) == self.expected_sha, 'BUNDLE_HASH_OR_SIZE_MISMATCH')
            require(before[2][2] == BINARY_BYTES and stream_hash(binary) == BINARY_SHA256, 'RESTIC_BINARY_HASH_MISMATCH')
            members = tar_members(bundle, self.expected_bytes)
            self.space(self.expected_bytes + BINARY_BYTES + OVERHEAD)
            self.root.mkdir(mode=0o700)
            self.created = True
            archive.sync_dir(self.root.parent)
            try:
                self.report.update(bundle_sha256=self.expected_sha, bundle_bytes=self.expected_bytes, restic_version=VERSION,
                                   restic_binary_sha256=BINARY_SHA256, tool_sha256=archive.digest(Path(__file__)),
                                   archive_helpers_sha256=archive.digest(Path(archive.__file__)), output_root=str(self.root))
                self.journal('extracting')
                for folder in ('export', 'scratch', 'restored'):
                    (self.root / folder).mkdir(mode=0o700)
                descriptor = os.open(self.root / 'restic', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
                with os.fdopen(descriptor, 'wb') as output:
                    binary.seek(0)
                    shutil.copyfileobj(binary, output)
                    output.flush()
                    os.fsync(output.fileno())
                require(archive.digest(self.root / 'restic') == BINARY_SHA256, 'RESTIC_BINARY_HASH_MISMATCH')
                self.extract(bundle, members)
                require(before == [fingerprint(stream) for stream in (bundle, password, binary)], 'INPUT_CHANGED_DURING_READ')
                index_path = self.root / 'export/index.json'
                index = validate_index(parse_json(index_path.read_bytes()))
                require(parse_json((self.root / 'export/identity.json').read_bytes()) ==
                        dict(format=1, purpose='release-dedup-pilot', restic_version=VERSION), 'PILOT_IDENTITY_MISMATCH')
                self.report.update(repository_id=index['repository_id'], index_sha256=archive.digest(index_path),
                                   identity_sha256=archive.digest(self.root / 'export/identity.json'))
                config = parse_json(self.restic('cat', 'config'))
                require(config.get('id') == index['repository_id'] and config.get('version') == 2, 'REPOSITORY_ID_MISMATCH')
                records = parse_json(self.restic('snapshots'))
                require(isinstance(records, list) and len(records) == len(ALLOW), 'EXACT_NINE_SNAPSHOTS_REQUIRED')
                require(all(isinstance(row, dict) for row in records), 'INVALID_SNAPSHOT_RECORD')
                by_id = {row.get('id'): row for row in records}
                require(set(by_id) == {entry['snapshot_id'] for entry in index['entries'].values()}, 'EXACT_SNAPSHOT_SET_MISMATCH')
                for entry in index['entries'].values():
                    record = by_id[entry['snapshot_id']]
                    require(record.get('hostname') == 'oasis-release-dedup-pilot'
                            and sorted(record.get('tags', [])) == sorted(['release=' + entry['release'], 'oasis-release-pilot-v1']), 'SNAPSHOT_IDENTITY_MISMATCH')
                self.journal('checking_all_repository_data')
                self.restic('check', '--read-data')
                self.report['check_read_data'] = 'passed'
                for name in ALLOW:
                    entry = index['entries'][name]
                    self.report['active_release'] = name
                    self.journal('validating_snapshot_metadata')
                    expected = self.metadata(entry)
                    self.restore(entry, expected)
                require(before == [fingerprint(stream) for stream in (bundle, password, binary)], 'INPUT_CHANGED_DURING_READ')
                require(not any((self.root / 'restored').iterdir()), 'RESTORE_CLEANUP_INCOMPLETE')
                self.report.pop('active_release', None)
                self.report.update(status='verified', completed_at_utc=stamp(), available_bytes=self.space(),
                                   compared_fields=['path', 'type', 'sha256', 'size', 'uid', 'gid', 'mode', 'mtime_ns', 'symlink_target'],
                                   excluded_fields=['ctime_ns'], independent_linux_recovery=platform.system() == 'Linux' and os.geteuid() == 0)
                self.journal('complete')
                return self.report
            except BaseException as error:
                self.report['status'] = 'failed'
                self.report['failed_phase'] = self.report.get('phase')
                # Exception messages from JSON/subprocess/OS may include sensitive input. Report only our fixed codes.
                message = str(error)
                self.report['error_code'] = message if type(error) is ValueError and re.fullmatch(r'[A-Z][A-Z0-9_]+', message) else type(error).__name__
                try:
                    self.journal('failed')
                except BaseException:
                    pass
                raise
            finally:
                self.password_stream = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--expected-bytes', required=True, type=int)
    parser.add_argument('--password-file', required=True, type=Path)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output-root', required=True, type=Path)
    options = parser.parse_args()
    task = None
    try:
        require(platform.system() == 'Linux' and os.geteuid() == 0, 'LINUX_ROOT_REQUIRED_FOR_POSIX_RESTORE')
        task = ReplicaVerifier(options.bundle, options.expected_sha256, options.expected_bytes,
                               options.password_file, options.binary, options.output_root)
        result = task.run()
        print(json.dumps(result, sort_keys=True))
    except BaseException as error:
        message = str(error)
        code = message if type(error) is ValueError and re.fullmatch(r'[A-Z][A-Z0-9_]+', message) else type(error).__name__
        print(json.dumps(dict(status='failed', error_code=code, evidence_retained=bool(task and task.created))))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
