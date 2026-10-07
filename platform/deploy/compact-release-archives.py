#!/usr/bin/env python3
"""Create and verify a second, deduplicated copy of nine release archives; retain every tar."""
import argparse
import bz2
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import time

SPEC = importlib.util.spec_from_file_location('release_archive', Path(__file__).with_name('archive-releases.py'))
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)
require = archive.require
VERSION = '0.19.1'
COMPRESSED_SHA256 = 'f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c'
BINARY_SHA256 = '20d4142678d0d95ec11a4759def1b73fd9190abc9ca19e4b62d067c0b387e639'
BINARY_BYTES = 30941346
OVERHEAD = 128 * 1024 ** 2


def secure_file(path, mode=0o600):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == mode, 'UNSAFE_PILOT_FILE')


def secure_directory(path):
    archive.directory(path)
    info = path.stat()
    require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, 'UNSAFE_PILOT_DIRECTORY')


def write_bytes(path, value, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def write_json(path, value):
    write_bytes(path, (json.dumps(value, indent=2, sort_keys=True) + '\n').encode())
    archive.sync_dir(path.parent)


class Compactor:
    def __init__(self, base=Path('/opt/oasis'), proc=Path('/proc'), reserve=archive.RESERVE):
        self.base = Path(base)
        self.legacy = archive.Archiver(self.base, proc, reserve)
        self.reserve = reserve
        self.root = self.base / 'release-dedup-pilot'
        self.repo = self.root / 'repo'
        self.password = self.root / 'password'
        self.binary = self.root / 'bin' / ('restic-' + VERSION)
        self.index_path = self.root / 'index.json'
        self.scratch = self.root / 'scratch'
        self.restored = self.root / 'restored'

    def space(self, extra=0):
        available = archive.available_bytes(self.base)
        require(available >= self.reserve + extra, 'INSUFFICIENT_PILOT_SPACE')
        return available

    def original(self, name):
        source, work, final = self.legacy.paths(name)
        protection = self.legacy.eligible(name)
        require(not source.exists() and not source.is_symlink(), 'ORIGINAL_RELEASE_STILL_PRESENT')
        require(not work.exists() and not work.is_symlink(), 'ORIGINAL_ARCHIVE_INCOMPLETE')
        require(not any((final / child).exists() or (final / child).is_symlink()
                        for child in ('original', 'restore-in-progress.json')), 'ORIGINAL_ARCHIVE_INCOMPLETE')
        data = self.legacy.archive_data(final, name)
        self.legacy.coverage(data)
        return final, data, protection

    def backup_budget(self, data):
        logical = sum(entry.get('size', 0) for entry in data['entries'].values())
        return 2 * archive.space_bounds(data)['extraction_upper_bytes'] + 2 * logical + 16 * len(json.dumps(data).encode()) + OVERHEAD

    def index(self):
        for path in (self.root, self.repo, self.root / 'bin', self.scratch, self.restored):
            secure_directory(path)
        secure_file(self.root / 'identity.json')
        require(json.loads((self.root / 'identity.json').read_text()) == dict(format=1, purpose='release-dedup-pilot', restic_version=VERSION), 'PILOT_IDENTITY_MISMATCH')
        secure_file(self.password)
        require(32 <= self.password.stat().st_size <= 1024, 'INVALID_PASSWORD_FILE_SIZE')
        secure_file(self.binary, 0o500)
        require(archive.digest(self.binary) == BINARY_SHA256, 'RESTIC_BINARY_HASH_MISMATCH')
        secure_file(self.index_path)
        data = json.loads(self.index_path.read_text())
        require(data.get('restic_version') == VERSION and ((data.get('format') == 1 and data.get('original_tar_policy') == 'retained')
                or (data.get('format') == 2 and data.get('original_tar_policy') == 'per_release')), 'INVALID_PILOT_INDEX')
        require(re.fullmatch(r'[a-f0-9]{64}', data.get('repository_id', '')) is not None, 'INVALID_REPOSITORY_ID')
        require(isinstance(data.get('entries'), dict) and set(data['entries']).issubset(archive.ALLOW), 'INVALID_PILOT_ENTRIES')
        for name, entry in data['entries'].items():
            require(entry.get('release') == name and entry.get('status') == 'verified', 'INVALID_PILOT_ENTRY')
            for key in ('snapshot_id', 'snapshot_sha256', 'receipt_sha256', 'archive_sha256', 'identity_sha256'):
                require(re.fullmatch(r'[a-f0-9]{64}', entry.get(key, '')) is not None, 'INVALID_PILOT_DIGEST')
            require(isinstance(entry.get('restore_upper_bytes'), int) and entry['restore_upper_bytes'] > 0, 'INVALID_RESTORE_BOUND')
        if data['format'] == 2:
            require(set(data['entries']) == set(archive.ALLOW), 'V2_EXACT_NINE_RELEASES_REQUIRED')
            retirement = data.get('retirement', {})
            require(retirement.get('format') == 1 and re.fullmatch(r'[a-f0-9]{64}', retirement.get('proof_sha256', '')),
                    'INVALID_RETIREMENT_BINDING')
            secure_directory(self.root / 'retirement')
            capsule = self.root / 'retirement/capsule.json'
            secure_file(capsule)
            require(archive.digest(capsule) == retirement['proof_sha256'], 'RETIREMENT_PROOF_CHANGED')
            for name, entry in data['entries'].items():
                state = archive.storage_state(self.legacy.archives / name, name)
                require(state is not None and entry.get('storage_protocol') == 1, 'V2_STORAGE_STATE_MISSING')
                require(state['repository_id'] == data['repository_id'] and state['proof_sha256'] == retirement['proof_sha256']
                        and all(state[key] == entry[key] for key in ('snapshot_id', 'archive_sha256', 'snapshot_sha256', 'receipt_sha256', 'identity_sha256')),
                        'V2_STORAGE_BINDING_MISMATCH')
        return data

    def tar_summary(self, index):
        states = {name: (archive.storage_state(self.legacy.archives / name, name) or {'state': 'retained'})['state']
                  for name in index['entries']}
        present = {}
        for name, state in states.items():
            path = self.legacy.archives / name / 'release.tar.gz'
            present[name] = bool(state == 'retained' and path.is_file() and not path.is_symlink()
                                 and path.stat().st_nlink == 1 and archive.digest(path) == index['entries'][name]['archive_sha256'])
        return dict(original_tars_retained=all(present.values()), original_tar_states=states,
                    verified_original_tar_presence=present)

    def restic(self, *args, cwd=None):
        self.space()
        command = [str(self.binary), '--repo', str(self.repo), '--password-file', str(self.password), '--no-cache', '--json', *args]
        result = subprocess.run(command, cwd=cwd or self.root, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                               'TMPDIR': str(self.scratch), 'GOMAXPROCS': '2'}, text=True, capture_output=True, timeout=1800)
        self.space()
        require(result.returncode == 0, 'RESTIC_COMMAND_FAILED_' + args[0].upper() + '_' + str(result.returncode))
        return result.stdout

    def repository(self, index):
        config = json.loads(self.restic('cat', 'config'))
        require(config.get('id') == index['repository_id'] and config.get('version') == 2, 'REPOSITORY_ID_MISMATCH')
        return config

    def check_only(self, names):
        index = self.index() if self.root.exists() or self.root.is_symlink() else None
        if index is not None:
            require(not any(self.scratch.iterdir()), 'INCOMPLETE_PILOT_REQUIRES_INSPECTION')
        rows = []
        for name in names:
            if index is not None and index['format'] == 2:
                folder = self.legacy.archives / name
                protection = self.legacy.eligible(name)
                data = self.legacy.archive_metadata(folder, name)
                self.original_matches_entry(folder, index['entries'][name])
                self.legacy.coverage(data)
            else:
                folder, data, protection = self.original(name)
            budget = self.backup_budget(data)
            available = self.space(budget)
            rows.append(dict(release=name, protection=protection, snapshot_sha256=archive.digest(folder / 'snapshot.json'),
                             available_bytes=available, temporary_conservative_upper_bytes=budget,
                             reserve_bytes=self.reserve, indexed=bool(index and name in index['entries'])))
        return dict(mode='check-only', initialized=index is not None, repository_verified=False,
                    **(self.tar_summary(index) if index else dict(original_tars_retained=True)), releases=rows)

    def initialize(self, binary_archive):
        binary_archive = Path(binary_archive)
        require(binary_archive.is_file() and not binary_archive.is_symlink(), 'UNSAFE_BINARY_ARCHIVE')
        require(archive.digest(binary_archive) == COMPRESSED_SHA256, 'RESTIC_DOWNLOAD_HASH_MISMATCH')
        binary = bz2.decompress(binary_archive.read_bytes())
        require(len(binary) == BINARY_BYTES and hashlib.sha256(binary).hexdigest() == BINARY_SHA256, 'RESTIC_BINARY_HASH_MISMATCH')
        with self.legacy.locked():
            self.legacy.protection()
            self.space(OVERHEAD + BINARY_BYTES)
            require(not self.root.exists() and not self.root.is_symlink(), 'PILOT_ALREADY_EXISTS')
            self.root.mkdir(mode=0o700)
            archive.sync_dir(self.base)
            for name in ('repo', 'bin', 'scratch', 'restored'):
                (self.root / name).mkdir(mode=0o700)
            write_json(self.root / 'identity.json', dict(format=1, purpose='release-dedup-pilot', restic_version=VERSION))
            write_bytes(self.password, (secrets.token_hex(32) + '\n').encode())
            write_bytes(self.binary, binary, mode=0o500)
            self.restic('init', '--repository-version', '2')
            config = json.loads(self.restic('cat', 'config'))
            require(re.fullmatch(r'[a-f0-9]{64}', config.get('id', '')) is not None and config.get('version') == 2, 'INVALID_REPOSITORY_ID')
            index = dict(format=1, restic_version=VERSION, repository_id=config['id'], original_tar_policy='retained', entries={})
            write_json(self.index_path, index)
            archive.sync_tree(self.root)
            archive.sync_dir(self.base)
            self.index()
            return dict(status='initialized', repository_id=config['id'], original_tars_retained=True, external_password_copy='not_verified')

    def new_work(self, name, operation):
        require(name in archive.ALLOW, 'RELEASE_NOT_ALLOWLISTED')
        require(not any(self.scratch.iterdir()), 'INCOMPLETE_PILOT_REQUIRES_INSPECTION')
        work = self.scratch / (operation + '-' + name)
        work.mkdir(mode=0o700)
        write_json(work / 'journal.json', dict(format=1, release=name, operation=operation, state='started'))
        archive.sync_dir(self.scratch)
        return work

    def snapshot_record(self, entry):
        records = json.loads(self.restic('snapshots', entry['snapshot_id']))
        require(isinstance(records, list) and len(records) == 1 and records[0].get('id') == entry['snapshot_id'], 'EXACT_SNAPSHOT_MISSING')
        require(records[0].get('hostname') == 'oasis-release-dedup-pilot'
                and set(records[0].get('tags', [])) == {'release=' + entry['release'], 'oasis-release-pilot-v1'}, 'SNAPSHOT_IDENTITY_MISMATCH')

    def original_matches_entry(self, folder, entry):
        for name in ('identity', 'snapshot', 'receipt'):
            require(archive.digest(folder / (name + '.json')) == entry[name + '_sha256'], 'INDEX_ORIGINAL_ARCHIVE_MISMATCH')
        receipt = json.loads((folder / 'receipt.json').read_text())
        require(receipt.get('archive_sha256') == entry['archive_sha256'], 'INDEX_ORIGINAL_ARCHIVE_MISMATCH')

    def restore_tree(self, entry, target):
        self.legacy.eligible(entry['release'])
        self.space(entry['restore_upper_bytes'] + OVERHEAD)
        require(not target.exists() and not target.is_symlink(), 'RESTORE_DESTINATION_EXISTS')
        self.snapshot_record(entry)
        original_metadata = self.restic('dump', entry['snapshot_id'], '/archive-metadata/snapshot.json')
        require(hashlib.sha256(original_metadata.encode()).hexdigest() == entry['snapshot_sha256'], 'RESTORE_METADATA_HASH_MISMATCH')
        expected = json.loads(original_metadata)
        require(archive.space_bounds(expected)['extraction_upper_bytes'] == entry['restore_upper_bytes'], 'RESTORE_SPACE_BOUND_MISMATCH')
        self.space(archive.space_bounds(expected)['extraction_upper_bytes'] + OVERHEAD)
        self.restic('restore', entry['snapshot_id'], '--target', str(target))
        require(set(path.name for path in target.iterdir()) == {entry['release'], 'archive-metadata'}, 'RESTORE_ROOT_MISMATCH')
        metadata = target / 'archive-metadata'
        archive.directory(metadata)
        require(set(path.name for path in metadata.iterdir()) == {'identity.json', 'snapshot.json', 'receipt.json'}, 'RESTORE_METADATA_SET_MISMATCH')
        for filename in ('identity', 'snapshot', 'receipt'):
            path = metadata / (filename + '.json')
            secure_file(path)
            require(archive.digest(path) == entry[filename + '_sha256'], 'RESTORE_METADATA_HASH_MISMATCH')
        data = json.loads((metadata / 'snapshot.json').read_text())
        receipt = json.loads((metadata / 'receipt.json').read_text())
        require(receipt.get('archive_sha256') == entry['archive_sha256']
                and receipt.get('snapshot_sha256') == entry['snapshot_sha256'], 'RESTORE_RECEIPT_MISMATCH')
        tree = target / entry['release']
        restored = archive.snapshot(tree)
        require(archive.content(restored) == archive.content(data), 'RESTIC_RESTORED_TREE_MISMATCH')
        archive.verify_manifest(tree, restored)
        self.legacy.coverage(data)
        self.legacy.eligible(entry['release'])
        return tree, data

    def verify_entry(self, entry, work):
        tree, _ = self.restore_tree(entry, work / 'verification')
        archive.sync_tree(tree)
        archive.sync_dir(tree.parent)
        return dict(release=entry['release'], snapshot_id=entry['snapshot_id'], status='verified')

    def remove_work(self, work):
        secure_directory(work)
        shutil.rmtree(work)
        archive.sync_dir(self.scratch)

    def backup(self, name):
        with self.legacy.locked():
            index = self.index()
            self.repository(index)
            if index['format'] == 2:
                require(name in index['entries'], 'INDEXED_RELEASE_REQUIRED')
                self.legacy.eligible(name)
                self.original_matches_entry(self.legacy.archives / name, index['entries'][name])
                work = self.new_work(name, 'backup')
                self.restic('check', '--read-data')
                result = self.verify_entry(index['entries'][name], work)
                self.remove_work(work)
                return dict(result, status='already_verified', **self.tar_summary(index))
            folder, data, _ = self.original(name)
            self.space(self.backup_budget(data))
            work = self.new_work(name, 'backup')
            if name in index['entries']:
                self.original_matches_entry(folder, index['entries'][name])
                self.restic('check', '--read-data')
                result = self.verify_entry(index['entries'][name], work)
                self.remove_work(work)
                return dict(result, status='already_verified', original_tars_retained=True)
            self.legacy.unpack(folder, work / 'input', name)
            metadata = work / 'input/archive-metadata'
            metadata.mkdir(mode=0o700)
            for filename in ('identity.json', 'snapshot.json', 'receipt.json'):
                write_bytes(metadata / filename, (folder / filename).read_bytes())
            receipt = json.loads((metadata / 'receipt.json').read_text())
            entry = dict(release=name, snapshot_sha256=archive.digest(metadata / 'snapshot.json'),
                         identity_sha256=archive.digest(metadata / 'identity.json'), receipt_sha256=archive.digest(metadata / 'receipt.json'),
                         archive_sha256=receipt['archive_sha256'], restore_upper_bytes=archive.space_bounds(data)['extraction_upper_bytes'])
            output = self.restic('backup', name, 'archive-metadata', '--host', 'oasis-release-dedup-pilot',
                                 '--tag', 'release=' + name, '--tag', 'oasis-release-pilot-v1', '--force', '--read-concurrency', '1', cwd=work / 'input')
            summaries = [line for line in (json.loads(value) for value in output.splitlines()) if line.get('message_type') == 'summary']
            require(len(summaries) == 1 and re.fullmatch(r'[a-f0-9]{64}', summaries[0].get('snapshot_id', '')) is not None, 'BACKUP_SNAPSHOT_ID_MISSING')
            entry.update(snapshot_id=summaries[0]['snapshot_id'], backup_summary=summaries[0])
            write_json(work / 'backup-result.json', entry)
            require(archive.content(archive.snapshot(work / 'input' / name)) == archive.content(data), 'BACKUP_SOURCE_CHANGED')
            shutil.rmtree(work / 'input')
            archive.sync_dir(work)
            self.restic('check', '--read-data')
            self.verify_entry(entry, work)
            _, current_data, _ = self.original(name)
            require(current_data == data, 'ORIGINAL_ARCHIVE_CHANGED')
            self.original_matches_entry(folder, entry)
            self.repository(index)
            entry.update(status='verified', verified_at_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
            index['entries'][name] = entry
            require(not (self.root / 'index.next.json').exists(), 'INCOMPLETE_INDEX_REQUIRES_INSPECTION')
            archive.sync_tree(self.repo)
            write_json(self.root / 'index.next.json', index)
            os.replace(self.root / 'index.next.json', self.index_path)
            archive.sync_dir(self.root)
            self.remove_work(work)
            return dict(status='verified', release=name, snapshot_id=entry['snapshot_id'], original_tars_retained=True,
                        repository_allocated_bytes=archive.allocated_bytes(self.repo), pilot_allocated_bytes=archive.allocated_bytes(self.root))

    def verify(self, names=None):
        with self.legacy.locked():
            index = self.index()
            self.repository(index)
            selected = names if names is not None else sorted(index['entries'])
            require(bool(selected) and all(name in index['entries'] for name in selected), 'INDEXED_RELEASE_REQUIRED')
            require(not any(self.scratch.iterdir()), 'INCOMPLETE_PILOT_REQUIRES_INSPECTION')
            self.restic('check', '--read-data')
            results = []
            for name in selected:
                self.legacy.eligible(name)
                work = self.new_work(name, 'verify')
                results.append(self.verify_entry(index['entries'][name], work))
                self.remove_work(work)
            return dict(status='verified', releases=results, **self.tar_summary(index),
                        repository_allocated_bytes=archive.allocated_bytes(self.repo), pilot_allocated_bytes=archive.allocated_bytes(self.root))

    def restore(self, name):
        with self.legacy.locked():
            index = self.index()
            self.repository(index)
            require(name in archive.ALLOW and name in index['entries'], 'INDEXED_RELEASE_REQUIRED')
            self.legacy.eligible(name)
            destination = self.restored / name
            require(not destination.exists() and not destination.is_symlink(), 'RESTORE_DESTINATION_EXISTS')
            self.restic('check', '--read-data')
            work = self.new_work(name, 'restore')
            tree, _ = self.restore_tree(index['entries'][name], work / 'output')
            archive.sync_tree(tree)
            archive.sync_dir(tree.parent)
            self.legacy.eligible(name)
            tree.rename(destination)
            archive.sync_dir(self.restored)
            archive.sync_dir(tree.parent)
            self.remove_work(work)
            return dict(status='restored', release=name, path=str(destination), snapshot_id=index['entries'][name]['snapshot_id'], published=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check-only', nargs='?', const='all', choices=('all', *archive.ALLOW))
    modes.add_argument('--init', action='store_true')
    modes.add_argument('--backup', choices=archive.ALLOW)
    modes.add_argument('--verify', nargs='?', const='all', choices=('all', *archive.ALLOW))
    modes.add_argument('--restore', choices=archive.ALLOW)
    parser.add_argument('--binary-archive', type=Path)
    args = parser.parse_args()
    require(os.geteuid() == 0 and os.uname().sysname == 'Linux', 'LINUX_ROOT_REQUIRED')
    require(not args.binary_archive or args.init, 'BINARY_ARCHIVE_ONLY_FOR_INIT')
    os.umask(0o077)
    task = Compactor()
    if args.init:
        require(args.binary_archive is not None, 'VERIFIED_BINARY_ARCHIVE_REQUIRED')
        result = task.initialize(args.binary_archive)
    elif args.backup:
        result = task.backup(args.backup)
    elif args.verify:
        result = task.verify(None if args.verify == 'all' else [args.verify])
    elif args.restore:
        result = task.restore(args.restore)
    else:
        result = task.check_only(list(archive.ALLOW) if args.check_only in (None, 'all') else [args.check_only])
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit('RELEASE_COMPACTION_REFUSED: ' + str(error))
