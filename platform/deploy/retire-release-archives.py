#!/usr/bin/env python3
"""Retire one allowlisted original tar after two independently verified Restic copies.

Default check-only does not execute Restic or write. --release-tar holds the
existing deployment/archive locks, verifies the proof capsule and a fresh exact
server restore, persists intent, then unlinks only that original tar. --recover
rolls back a still-present quarantine; it never unlinks a tar. Metadata and both
recovery copies are retained. No forget/prune, publication or password output.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

SPEC = importlib.util.spec_from_file_location('retirement_compactor', Path(__file__).with_name('compact-release-archives.py'))
compact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compact)
archive = compact.archive
require = archive.require
DIGEST_KEYS = ('snapshot_id', 'snapshot_sha256', 'identity_sha256', 'receipt_sha256', 'archive_sha256')
PROOF_FILES = ('materials.json', 'transfer-proof.json', 'linux-restore-report.json', 'source-index.json')
QUARANTINE = 'release.tar.gz.retiring'
LIMIT = 8 * 1024**2


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, 'DUPLICATE_PROOF_JSON_KEY')
        result[key] = value
    return result


def decode(value):
    return json.loads(value, object_pairs_hook=pairs)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def read_bytes(path, exact_mode=None):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.geteuid()
                and not stat.S_IMODE(before.st_mode) & 0o022 and before.st_size <= LIMIT, 'UNSAFE_RETIREMENT_INPUT')
        require(exact_mode is None or stat.S_IMODE(before.st_mode) == exact_mode, 'UNSAFE_RETIREMENT_MODE')
        value = stream.read(LIMIT + 1)
        after = os.fstat(stream.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'RETIREMENT_INPUT_CHANGED')
        require(len(value) <= LIMIT, 'RETIREMENT_INPUT_TOO_LARGE')
        return value


def atomic_json(path, value):
    # Interrupted pre-rename files are retained for inspection, never mistaken for the authoritative state.
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(12) + '.next')
    compact.write_json(temporary, value)
    if path.exists() or path.is_symlink():
        read_bytes(path, 0o600)
    os.replace(temporary, path)
    archive.sync_dir(path.parent)


def stat_record(info):
    return {key: getattr(info, 'st_' + key) for key in ('dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtime_ns', 'ctime_ns', 'blocks')}


def tar_fingerprint(path, expected_sha, recorded=None):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        first = os.fstat(stream.fileno())
        require(stat.S_ISREG(first.st_mode) and first.st_nlink == 1 and first.st_uid == os.geteuid()
                and not stat.S_IMODE(first.st_mode) & 0o022, 'UNSAFE_RETIREMENT_TAR')
        record = stat_record(first)
        if recorded is not None:
            # rename changes ctime; content and every stable identity attribute must still match.
            require(all(record[key] == recorded.get(key) for key in record if key not in ('ctime_ns', 'blocks')),
                    'RETIREMENT_TAR_IDENTITY_CHANGED')
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        require(digest.hexdigest() == expected_sha, 'RETIREMENT_TAR_HASH_MISMATCH')
        require(stat_record(os.fstat(stream.fileno())) == record and stat_record(path.lstat()) == record, 'RETIREMENT_TAR_CHANGED_DURING_READ')
        return record


def validate_proof(raw, expected_transfer, expected_index):
    """Validate a trusted externally pinned transfer receipt and its full evidence chain."""
    require(set(raw) == set(PROOF_FILES), 'PROOF_FILE_SET_MISMATCH')
    require(sha(raw['transfer-proof.json']) == expected_transfer and sha(raw['source-index.json']) == expected_index,
            'PROOF_EXTERNAL_PIN_MISMATCH')
    material, transfer, report, index = (decode(raw[name]) for name in PROOF_FILES)
    require(transfer.get('format') == 1 and transfer.get('material_receipt_sha256') == sha(raw['materials.json'])
            and transfer.get('linux_report_sha256') == sha(raw['linux-restore-report.json']), 'PROOF_RECEIPT_HASH_MISMATCH')
    require(all(transfer.get(key) is True for key in ('independent_linux_recovery', 'password_copied_separately_from_mac',
                'mac_materials_read_back', 'original_tars_retained')) and transfer.get('verified_releases') == 9, 'SECOND_COPY_TRANSFER_NOT_VERIFIED')
    require(material.get('format') == 1 and material.get('source') == 'independent-mac-copy'
            and material.get('original_tars_retained') is True, 'MAC_MATERIAL_RECEIPT_INVALID')
    require(index.get('format') == 1 and index.get('restic_version') == compact.VERSION and index.get('original_tar_policy') == 'retained'
            and isinstance(index.get('entries'), dict) and set(index['entries']) == set(archive.ALLOW), 'PROOF_SOURCE_INDEX_INVALID')
    require(report.get('format') == 1 and report.get('purpose') == 'independent-release-replica-verification'
            and report.get('status') == 'verified' and report.get('phase') == 'complete' and report.get('check_read_data') == 'passed'
            and report.get('independent_linux_recovery') is True and report.get('original_repository_consulted') is False
            and report.get('original_tars_modified') is False and report.get('published') is False, 'INDEPENDENT_RESTORE_NOT_VERIFIED')
    require(report.get('restic_version') == compact.VERSION and report.get('restic_binary_sha256') == compact.BINARY_SHA256
            and report.get('excluded_fields') == ['ctime_ns']
            and set(report.get('compared_fields', [])) == {'path', 'type', 'sha256', 'size', 'uid', 'gid', 'mode', 'mtime_ns', 'symlink_target'},
            'INDEPENDENT_RESTORE_SCOPE_MISMATCH')
    repository = index.get('repository_id')
    require(isinstance(repository, str) and re.fullmatch(r'[a-f0-9]{64}', repository)
            and all(item.get('repository_id') == repository for item in (material, transfer, report)), 'PROOF_REPOSITORY_MISMATCH')
    require(report.get('index_sha256') == transfer.get('index_sha256') == expected_index, 'PROOF_INDEX_MISMATCH')
    materials = material.get('materials', {})
    require(set(materials) == {'repository.tar', 'restic-' + compact.VERSION, 'verify-release-replica.py', 'archive-releases.py'}, 'MATERIAL_SET_MISMATCH')
    for filename, digest in (('repository.tar', report.get('bundle_sha256')), ('restic-' + compact.VERSION, compact.BINARY_SHA256),
                             ('verify-release-replica.py', report.get('tool_sha256')), ('archive-releases.py', report.get('archive_helpers_sha256'))):
        require(isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest)
                and materials[filename].get('sha256') == digest and type(materials[filename].get('bytes')) is int
                and materials[filename]['bytes'] > 0, 'MATERIAL_HASH_MISMATCH')
    require(materials['restic-' + compact.VERSION]['bytes'] == compact.BINARY_BYTES, 'MATERIAL_BINARY_SIZE_MISMATCH')
    require(report.get('bundle_sha256') == transfer.get('bundle_sha256') and report.get('bundle_bytes') == transfer.get('bundle_bytes')
            == materials['repository.tar']['bytes'], 'PROOF_BUNDLE_MISMATCH')
    rows = report.get('releases')
    require(isinstance(rows, list) and len(rows) == 9 and all(isinstance(row, dict) for row in rows), 'NINE_RESTORE_RESULTS_REQUIRED')
    by_name = {row.get('release'): row for row in rows}
    require(set(by_name) == set(archive.ALLOW), 'RESTORE_RELEASE_SET_MISMATCH')
    ids = set()
    for name, entry in index['entries'].items():
        require(entry.get('release') == name and entry.get('status') == 'verified', 'PROOF_INDEX_ENTRY_INVALID')
        row = by_name[name]
        require(row.get('status') == 'verified' and row.get('temporary_restore_removed') is True
                and type(row.get('entries')) is int and row['entries'] > 0 and type(row.get('manifest_files')) is int and row['manifest_files'] > 0,
                'RESTORE_RESULT_INCOMPLETE')
        for key in DIGEST_KEYS:
            require(isinstance(entry.get(key), str) and re.fullmatch(r'[a-f0-9]{64}', entry[key]) and row.get(key) == entry[key], 'PROOF_SNAPSHOT_BINDING_MISMATCH')
        require(entry['snapshot_id'] not in ids, 'DUPLICATE_PROOF_SNAPSHOT_ID')
        ids.add(entry['snapshot_id'])
    return index


class Retirer:
    def __init__(self, base=Path('/opt/oasis'), proc=Path('/proc'), reserve=archive.RESERVE):
        self.task = compact.Compactor(base, proc, reserve)
        self.base, self.root, self.legacy = self.task.base, self.task.root, self.task.legacy
        self.capsule_dir = self.root / 'retirement'
        self.reserve = reserve

    def proof_inputs(self, index, proof_directory=None, expected_transfer=None, expected_index=None):
        # Before the v2 index durably anchors the capsule, even a resumed preparation
        # must supply the two independently retained pins again.
        require(index['format'] != 1 or (expected_transfer and expected_index), 'PINNED_SECOND_COPY_PROOF_REQUIRED')
        if index['format'] == 2 or (self.capsule_dir / 'capsule.json').exists():
            compact.secure_directory(self.capsule_dir)
            capsule_raw = read_bytes(self.capsule_dir / 'capsule.json', 0o600)
            capsule = decode(capsule_raw)
            require(capsule.get('format') == 1 and capsule.get('purpose') == 'original-tar-retirement', 'CAPSULE_IDENTITY_MISMATCH')
            require(not expected_transfer or expected_transfer == capsule['transfer_sha256'], 'PROOF_EXTERNAL_PIN_MISMATCH')
            require(not expected_index or expected_index == capsule['source_index_sha256'], 'PROOF_EXTERNAL_PIN_MISMATCH')
            if index['format'] == 2:
                require(index['retirement']['proof_sha256'] == sha(capsule_raw), 'RETIREMENT_PROOF_CHANGED')
            raw = {name: read_bytes(self.capsule_dir / name, 0o600) for name in PROOF_FILES}
            require(capsule.get('files') == {name: sha(value) for name, value in raw.items()}, 'CAPSULE_FILE_HASH_MISMATCH')
            original = validate_proof(raw, capsule['transfer_sha256'], capsule['source_index_sha256'])
        else:
            require(proof_directory is not None and expected_transfer and expected_index, 'PINNED_SECOND_COPY_PROOF_REQUIRED')
            proof_directory = Path(proof_directory)
            require(proof_directory.is_absolute() and not proof_directory.is_symlink(), 'UNSAFE_PROOF_DIRECTORY')
            archive.directory(proof_directory)
            raw = {name: read_bytes(proof_directory / name) for name in PROOF_FILES if name != 'source-index.json'}
            raw['source-index.json'] = read_bytes(self.task.index_path, 0o600)
            original = validate_proof(raw, expected_transfer, expected_index)
            capsule = dict(format=1, purpose='original-tar-retirement', repository_id=original['repository_id'],
                           source_index_sha256=expected_index, transfer_sha256=expected_transfer,
                           files={name: sha(value) for name, value in raw.items()})
            capsule_raw = (json.dumps(capsule, indent=2, sort_keys=True) + '\n').encode()
        require(index['repository_id'] == original['repository_id'] and set(index['entries']) == set(original['entries']), 'LIVE_INDEX_PROOF_MISMATCH')
        for name, entry in index['entries'].items():
            require(all(entry[key] == original['entries'][name][key] for key in (*DIGEST_KEYS, 'restore_upper_bytes')), 'LIVE_INDEX_PROOF_MISMATCH')
        return raw, capsule, capsule_raw, original

    def metadata(self, name, entry):
        source, work, folder = self.legacy.paths(name)
        protection = self.legacy.eligible(name)
        require(not source.exists() and not source.is_symlink(), 'RELEASE_TREE_PRESENT')
        require(not work.exists() and not work.is_symlink(), 'ARCHIVE_WORK_PRESENT')
        compact.secure_directory(folder)
        require(not any((folder / child).exists() or (folder / child).is_symlink()
                        for child in ('original', 'recovery', 'restore-in-progress.json')), 'ARCHIVE_RECOVERY_IN_PROGRESS')
        for key in ('identity', 'snapshot', 'receipt'):
            require(sha(read_bytes(folder / (key + '.json'))) == entry[key + '_sha256'], 'ORIGINAL_METADATA_CHANGED')
        data = self.legacy.archive_metadata(folder, name)
        self.task.original_matches_entry(folder, entry)
        self.legacy.coverage(data)
        return folder, data, protection

    def layout(self, folder, state, entry):
        canonical, quarantine = folder / 'release.tar.gz', folder / QUARANTINE
        existing = [path for path in (canonical, quarantine) if path.exists() or path.is_symlink()]
        phase = state['state'] if state else 'retained'
        require(len(existing) <= 1, 'AMBIGUOUS_RETIREMENT_TAR_PATHS')
        if phase == 'retained':
            require(existing == [canonical], 'RETAINED_TAR_MISSING_OR_MOVED')
        elif phase == 'quarantine_prepared':
            require(len(existing) == 1, 'PREPARED_TAR_MISSING')
        elif phase == 'quarantined':
            require(existing == [quarantine], 'QUARANTINE_TAR_MISSING')
        elif phase == 'unlink_prepared':
            require(not existing or existing == [quarantine], 'UNLINK_STATE_TAR_PATH_MISMATCH')
        elif phase == 'restic_only':
            require(not existing, 'RELEASED_TAR_REAPPEARED')
        if existing:
            return existing[0], tar_fingerprint(existing[0], entry['archive_sha256'], state.get('original_tar_stat') if state else None)
        return None, None

    def state(self, folder, name, entry, index, proof_sha):
        state = archive.storage_state(folder, name)
        require(index['format'] != 2 or state is not None, 'V2_STORAGE_STATE_MISSING')
        if state:
            require(state['repository_id'] == index['repository_id'] and state['proof_sha256'] == proof_sha
                    and all(state[key] == entry[key] for key in DIGEST_KEYS), 'STORAGE_PROOF_BINDING_MISMATCH')
            require(isinstance(state.get('original_tar_stat'), dict), 'STORAGE_TAR_IDENTITY_MISSING')
            identity = state['original_tar_stat']
            require(set(identity) == {'dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtime_ns', 'ctime_ns', 'blocks'}
                    and all(type(value) is int and value >= 0 for value in identity.values()) and identity['nlink'] == 1
                    and stat.S_ISREG(identity['mode']), 'INVALID_STORAGE_TAR_IDENTITY')
            require(index['format'] != 1 or state['state'] == 'retained', 'V1_DESTRUCTIVE_STATE_FORBIDDEN')
        return state

    def inspect(self, name, proof_directory=None, expected_transfer=None, expected_index=None):
        require(name in archive.ALLOW, 'RELEASE_NOT_ALLOWLISTED')
        index = self.task.index()
        raw, capsule, capsule_raw, original = self.proof_inputs(index, proof_directory, expected_transfer, expected_index)
        entry = index['entries'][name]
        folder, data, protection = self.metadata(name, entry)
        state = self.state(folder, name, entry, index, sha(capsule_raw))
        path, info = self.layout(folder, state, entry)
        self.task.space(entry['restore_upper_bytes'] + compact.OVERHEAD)
        require(not any(self.task.scratch.iterdir()), 'INCOMPLETE_PILOT_REQUIRES_INSPECTION')
        report = dict(mode='check-only', release=name, state=state['state'] if state else 'retained', repository_verified=False,
                      proof_sha256=sha(capsule_raw), snapshot_id=entry['snapshot_id'],
                      original_tar_present=path is not None, tar_allocated_bytes=info['blocks'] * 512 if info else 0,
                      reserve_bytes=self.reserve, protection=protection)
        return report, index, raw, capsule, capsule_raw, entry, folder, state

    def initialize_v2(self, index, raw, capsule, capsule_raw):
        if index['format'] == 2:
            return index
        if not self.capsule_dir.exists():
            self.capsule_dir.mkdir(mode=0o700)
            archive.sync_dir(self.root)
        compact.secure_directory(self.capsule_dir)
        require({path.name for path in self.capsule_dir.iterdir()}.issubset({*PROOF_FILES, 'capsule.json'}), 'UNKNOWN_CAPSULE_CONTENT')
        for name, value in {**raw, 'capsule.json': capsule_raw}.items():
            destination = self.capsule_dir / name
            if destination.exists() or destination.is_symlink():
                require(read_bytes(destination, 0o600) == value, 'CAPSULE_PREPARATION_CONFLICT')
            else:
                compact.write_bytes(destination, value)
                archive.sync_dir(self.capsule_dir)
        proof_sha = sha(capsule_raw)
        for name, entry in index['entries'].items():
            folder, _, _ = self.metadata(name, entry)
            state = self.state(folder, name, entry, index, proof_sha)
            _, info = self.layout(folder, state, entry)
            if state is None:
                state = {key: entry[key] for key in DIGEST_KEYS} | dict(format=1, release=name, state='retained',
                            repository_id=index['repository_id'], proof_sha256=proof_sha, original_tar_stat=info)
                atomic_json(folder / 'storage.json', state)
            entry['storage_protocol'] = 1
        index.update(format=2, original_tar_policy='per_release', retirement=dict(format=1, proof_sha256=proof_sha))
        atomic_json(self.task.index_path, index)
        return self.task.index()

    def write_state(self, folder, state, phase):
        state = dict(state, state=phase, updated_at_utc=now())
        atomic_json(folder / 'storage.json', state)
        return state

    def fresh_server_restore(self, entry):
        self.task.repository(self.task.index())
        self.task.restic('check', '--read-data')
        work = self.task.new_work(entry['release'], 'retire')
        result = self.task.verify_entry(entry, work)
        require(result['status'] == 'verified', 'SERVER_RESTORE_NOT_VERIFIED')
        self.task.remove_work(work)
        return dict(snapshot_id=entry['snapshot_id'], verified_at_utc=now(), full_data_check='passed',
                    tool_sha256=archive.digest(Path(__file__)), compact_sha256=archive.digest(Path(compact.__file__)))

    def release_tar(self, name, proof_directory=None, expected_transfer=None, expected_index=None):
        with self.legacy.locked():
            _, index, raw, capsule, capsule_raw, entry, folder, state = self.inspect(name, proof_directory, expected_transfer, expected_index)
            index = self.initialize_v2(index, raw, capsule, capsule_raw)
            state = self.state(folder, name, entry, index, sha(capsule_raw))
            if state['state'] == 'restic_only':
                return dict(status='already_released', release=name, published=False, original_tar_present=False)
            require(state['state'] in ('retained', 'quarantined'), 'RETIREMENT_REQUIRES_RECOVER')
            verification = self.fresh_server_restore(entry)
            # Re-read the immutable evidence, index and original metadata after the slow restore.
            self.inspect(name)
            state = dict(state, server_verification=verification)
            if state['state'] == 'retained':
                self.layout(folder, state, entry)
                state = self.write_state(folder, state, 'quarantine_prepared')
                (folder / 'release.tar.gz').rename(folder / QUARANTINE)
                archive.sync_dir(folder)
                self.layout(folder, state, entry)
                state = self.write_state(folder, state, 'quarantined')
            self.inspect(name)
            state = self.write_state(folder, state, 'unlink_prepared')
            # Directory ownership and both locks exclude non-root/cooperating writers. Re-hash at the last boundary.
            self.metadata(name, entry)
            target, info = self.layout(folder, state, entry)
            require(target == folder / QUARANTINE, 'EXACT_QUARANTINE_REQUIRED')
            self.task.space()
            before = archive.available_bytes(self.base)
            descriptor = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                require(stat_record(os.stat(QUARANTINE, dir_fd=descriptor, follow_symlinks=False)) == info, 'RETIREMENT_TAR_CHANGED_BEFORE_UNLINK')
                os.unlink(QUARANTINE, dir_fd=descriptor)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            state = dict(state, released_tar_allocated_bytes=info['blocks'] * 512, released_at_utc=now())
            self.write_state(folder, state, 'restic_only')
            self.inspect(name)
            return dict(status='released', release=name, original_tar_present=False, released_tar_allocated_bytes=info['blocks'] * 512,
                        filesystem_available_delta_bytes=archive.available_bytes(self.base) - before,
                        snapshot_id=entry['snapshot_id'], proof_sha256=sha(capsule_raw), metadata_retained=True, published=False)

    def recover(self, name, proof_directory=None, expected_transfer=None, expected_index=None):
        with self.legacy.locked():
            _, index, raw, capsule, capsule_raw, entry, folder, state = self.inspect(name, proof_directory, expected_transfer, expected_index)
            if index['format'] == 1:
                self.initialize_v2(index, raw, capsule, capsule_raw)
                return dict(status='preparation_completed_no_tar_removed', release=name)
            if state['state'] in ('retained', 'restic_only'):
                return dict(status='no_recovery_needed', release=name, state=state['state'])
            path, _ = self.layout(folder, state, entry)
            if path is not None:
                # Durable rollback intent uses the same prepared phase, whose legal layouts cover either filename.
                state = self.write_state(folder, state, 'quarantine_prepared')
                if path.name == QUARANTINE:
                    path.rename(folder / 'release.tar.gz')
                    archive.sync_dir(folder)
                self.layout(folder, state, entry)
                self.write_state(folder, state, 'retained')
                return dict(status='tar_retained_after_recovery', release=name, original_tar_present=True)
            require(state['state'] == 'unlink_prepared' and state.get('server_verification', {}).get('snapshot_id') == entry['snapshot_id'],
                    'UNLINK_COMPLETION_NOT_PROVEN')
            verification = self.fresh_server_restore(entry)
            self.inspect(name)
            state = dict(state, server_verification=verification, release_completion_recovered_at_utc=now(),
                         released_tar_allocated_bytes=state['original_tar_stat']['blocks'] * 512)
            self.write_state(folder, state, 'restic_only')
            self.inspect(name)
            return dict(status='release_completion_recovered', release=name, original_tar_present=False, metadata_retained=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', choices=archive.ALLOW)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check-only', action='store_true')
    mode.add_argument('--release-tar', action='store_true')
    mode.add_argument('--recover', action='store_true')
    parser.add_argument('--proof-directory', type=Path)
    parser.add_argument('--expected-transfer-sha256')
    parser.add_argument('--expected-index-sha256')
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0 and os.uname().sysname == 'Linux', 'LINUX_ROOT_REQUIRED')
        os.umask(0o077)
        task = Retirer()
        parameters = (args.release, args.proof_directory, args.expected_transfer_sha256, args.expected_index_sha256)
        result = task.release_tar(*parameters) if args.release_tar else task.recover(*parameters) if args.recover else task.inspect(*parameters)[0]
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except BaseException as error:
        value = str(error)
        code = value if type(error) is ValueError and re.fullmatch(r'[A-Z][A-Z0-9_]+', value) else type(error).__name__
        print(json.dumps(dict(status='refused', error_code=code, evidence_retained=True)))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
