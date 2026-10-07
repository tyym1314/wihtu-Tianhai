#!/usr/bin/env python3
"""Reversibly archive exactly three inactive releases for the capacity08 batch.

This independent batch permanently retains its verified tar files. It reuses the
existing Archiver protocol without changing the original nine-release allowlist,
archive directory, metadata or Restic recovery material. No offsite backup is
claimed. The default is a read-only check of the selected release or all three releases.

Keep this file and adjacent archive-releases.py, publish-static-assets.py and
release_build.py together, with independently recorded hashes, for recovery.
Only missing, source-manifested fingerprints can use the registered stable store;
current same-URL corruption never uses that fallback. Store loss can block the
guarded restore; the permanent tar and complete original snapshot remain intact.
Check-only is an unlocked observation, never permission to skip locked rechecks.
New check/archive operations require the frozen current07/Mock04/previous06 and
hot06/05/04 context at every eligibility checkpoint. Recovery/restore uses fresh
protection without requiring future deployments to keep this old context.
Only the existing 3 GiB reserve governs archive/extract scratch space. This tool
never declares a subsequent release within its separate 85 percent disk gate.
"""
import argparse
import builtins
from contextlib import contextmanager
import hashlib
import gzip
import types
import importlib.util
import json
import os
from pathlib import Path
import tarfile


_dependency = Path(__file__).with_name('archive-releases.py')
_spec = importlib.util.spec_from_file_location('capacity08_archive_protocol', _dependency)
archive = importlib.util.module_from_spec(_spec)
exec(compile(_dependency.read_bytes(), str(_dependency), 'exec'), archive.__dict__)

# Compile trusted adjacent sources without creating __pycache__ and without
# replacing a caller's sys.modules entry. The publisher's only project import
# is resolved to this exact adjacent release_build, not a PYTHONPATH copy.
def adjacent_module(name, filename, project_imports=None):
    path = Path(__file__).with_name(filename)
    module = types.ModuleType(name)
    module.__file__ = str(path)
    imports = project_imports or {}
    def trusted_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and name in imports:
            return imports[name]
        return builtins.__import__(name, globals, locals, fromlist, level)
    module.__dict__['__builtins__'] = dict(vars(builtins), __import__=trusted_import)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


release_build = adjacent_module('capacity08_release_build', 'release_build.py')
publisher = adjacent_module('capacity08_static_publisher', 'publish-static-assets.py',
                            {'release_build': release_build})

ALLOW = ('20261008-03', '20260922-05', '20260922-06')
BASELINE_PINS = {'current': '20261008-07', 'android-mock-current': '20261007-04'}
BASELINE_PREVIOUS = '20261008-06'
BASELINE_HOT = ('20261008-06', '20261008-05', '20261008-04')
BASELINE_PROTECTED = frozenset((*BASELINE_PINS.values(), BASELINE_PREVIOUS, *BASELINE_HOT))
ARCHIVE_DIRECTORY = 'release-archives-capacity08-20261008'
TOOL = 'archive-capacity08-releases.py'


class Capacity08Archiver(archive.Archiver):
    def __init__(self, base=Path('/opt/oasis'), proc=Path('/proc'), reserve=archive.RESERVE):
        super().__init__(base, proc, reserve)
        self.archives = self.base / ARCHIVE_DIRECTORY
        self._release = None
        self._baseline_required = False
        self._coverage_report = None

    @contextmanager
    def release_scope(self, name):
        archive.require(name in ALLOW, 'RELEASE_NOT_ALLOWLISTED')
        archive.require(self._release in (None, name), 'AMBIGUOUS_CAPACITY08_OPERATION')
        previous = self._release
        if previous is None:
            self._coverage_report = None
        self._release = name
        try:
            yield
        finally:
            self._release = previous

    @contextmanager
    def baseline_scope(self):
        previous = self._baseline_required
        self._baseline_required = True
        try:
            yield
        finally:
            self._baseline_required = previous

    def protection(self):
        result = super().protection()
        # Historical batch protections never disappear when the newest three
        # move forward. Recovery still checks every fresh live/process pin.
        result['protected'] = sorted(set(result['protected']) | BASELINE_PROTECTED)
        return result

    def eligible(self, name):
        result = super().eligible(name)
        if self._baseline_required:
            archive.require(result['pins'] == BASELINE_PINS
                            and result['previous'] == BASELINE_PREVIOUS
                            and result['recent_retained'] == list(BASELINE_HOT),
                            'CAPACITY08_BASELINE_CHANGED')
        return result

    def check(self, name):
        with self.release_scope(name), self.baseline_scope():
            report, before = super().check(name)
            report['static_coverage'] = self._coverage_report
            report['batch_baseline'] = dict(pins=BASELINE_PINS, previous=BASELINE_PREVIOUS,
                                           hot=list(BASELINE_HOT))
            return report, before

    def archive(self, name):
        with self.release_scope(name), self.baseline_scope():
            result = super().archive(name)
            return dict(result, static_coverage=self._coverage_report,
                        gzip_full_stream_verified=True)

    def unpack(self, folder, target, name):
        # Authenticate the compressed file, then read to actual gzip EOF before
        # the inherited tar member checks and real POSIX snapshot restoration.
        # tar readers may stop at end-of-archive before noticing a bad CRC/footer.
        before = self.archive_data(folder, name)
        upper = archive.space_bounds(before)['archive_conservative_upper_bytes']
        produced = 0
        try:
            with gzip.open(folder / 'release.tar.gz', 'rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    produced += len(block)
                    archive.require(produced <= upper, 'CAPACITY08_GZIP_STREAM_TOO_LARGE')
        except (EOFError, OSError) as error:
            raise ValueError('CAPACITY08_GZIP_STREAM_INVALID') from error
        archive.require(produced > 0, 'CAPACITY08_GZIP_STREAM_EMPTY')
        # The writer emits one complete PAX tar with two zero EOF blocks and
        # RECORDSIZE padding. Do not accept hidden data after its final member.
        with tarfile.open(folder / 'release.tar.gz', 'r:gz') as stream:
            members = stream.getmembers()
            archive.require(bool(members), 'CAPACITY08_TAR_STREAM_EMPTY')
            end = max(item.offset_data + ((item.size + 511) // 512) * 512 for item in members)
        expected = ((end + 1024 + tarfile.RECORDSIZE - 1) // tarfile.RECORDSIZE) * tarfile.RECORDSIZE
        archive.require(produced == expected, 'CAPACITY08_TAR_STREAM_LENGTH')
        with gzip.open(folder / 'release.tar.gz', 'rb') as stream:
            stream.seek(end)
            archive.require(not any(stream.read()), 'CAPACITY08_TAR_TRAILING_DATA')
        return super().unpack(folder, target, name)

    def recover(self, name, restore=False):
        with self.release_scope(name):
            result = super().recover(name, restore=restore)
            return dict(result, static_coverage=self._coverage_report)

    def coverage_tree(self, snapshot_data):
        # At inherited coverage checkpoints the complete tree is either still
        # live in releases, quarantined, or freshly unpacked for recovery.
        # Prefer the actual recovery tree over its older quarantined original.
        archive.require(self._release in ALLOW, 'CAPACITY08_RELEASE_CONTEXT_REQUIRED')
        source, work, final = self.paths(self._release)
        roots = (source, work / 'recovery' / self._release, final / 'recovery' / self._release,
                 work / 'original', final / 'original')
        for root in roots:
            if root.exists() or root.is_symlink():
                archive.directory(root)
                path = release_build.regular_path(root, 'RELEASE-MANIFEST.json')
                entry = snapshot_data['entries'].get('RELEASE-MANIFEST.json', {})
                archive.require(entry.get('type') == 'file' and archive.digest(path) == entry.get('sha256'),
                                'CAPACITY08_MANIFEST_CHANGED')
                archive.verify_manifest(root, snapshot_data)
                return root
        raise ValueError('CAPACITY08_COVERAGE_TREE_MISSING')

    def coverage(self, snapshot_data):
        current = (self.base / 'current').resolve(strict=True)
        required = {name: entry for name, entry in snapshot_data['entries'].items()
                    if entry['type'] == 'file' and name.startswith(archive.STATIC)
                    and archive.FINGERPRINT.search(name)}
        missing = {}
        for name, entry in required.items():
            path = release_build.regular_path(current, name, missing=True)
            if path.exists():
                archive.require(archive.digest(path) == entry['sha256'], 'CURRENT_STATIC_ASSET_HASH_MISMATCH')
            else:
                missing[name] = entry
        report = {'current_files': len(required) - len(missing), 'global_files': len(missing),
                  'global_verification': None}
        if missing:
            root = self.coverage_tree(snapshot_data)
            declared, manifest_sha = publisher.manifest_assets(root)
            archive.require(manifest_sha == snapshot_data['entries']['RELEASE-MANIFEST.json']['sha256'],
                            'CAPACITY08_MANIFEST_CHANGED')
            for name, entry in missing.items():
                public = release_build.static_public_path(name)
                item = declared.get(public, {})
                archive.require(item.get('source') == name and item.get('sha256') == entry['sha256']
                                and item.get('bytes') == entry['size'], 'CAPACITY08_UNDECLARED_GLOBAL_ASSET')
            # Includes anchored receipts, absence of pending publish, ALL store
            # bodies (including newer versions), and this release's exact URLs.
            # Mutation checkpoints inherit the existing shared release lock.
            verified = publisher.verify_coverage(root, self.base)
            head_after = publisher.load_head(self.base)
            archive.require(hashlib.sha256(publisher.json_bytes(head_after)).hexdigest() == verified['head_sha256'],
                            'STATIC_HEAD_CHANGED')
            report['global_verification'] = verified
        self._coverage_report = report
        return len(required)

    def paths(self, name):
        archive.require(name in ALLOW, 'RELEASE_NOT_ALLOWLISTED')
        return self.releases / name, self.archives / ('.work-' + name), self.archives / name

    def archive_identity(self, folder, name):
        super().archive_identity(folder, name)
        state = folder / 'storage.json'
        archive.require(not state.exists() and not state.is_symlink(), 'CAPACITY08_TAR_RETIREMENT_NOT_SUPPORTED')


def commands(result):
    """Keep recovery instructions bound to this exact batch and entry point."""
    name = result['release']
    archive.require(name in ALLOW, 'RELEASE_NOT_ALLOWLISTED')
    return dict(result, tar_policy='permanently_retained',
                recover_command=f'python3 {TOOL} {name} --recover',
                restore_command=f'python3 {TOOL} {name} --restore')


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog='Archive exactly one release, inspect measured reclaimed_bytes, then recheck '
               'before another. --recover resolves interrupted work; --restore restores a '
               'completed archive and retains the tar. Neither command switches live traffic.')
    parser.add_argument('release', nargs='?', choices=ALLOW,
                        help='Exactly one release for mutation; omit only for check-only')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check-only', action='store_true',
                       help='Read-only checks; creates no locks or files (default)')
    modes.add_argument('--archive', action='store_true',
                       help='Compress, really restore and verify, then reclaim one original directory')
    modes.add_argument('--recover', action='store_true', help='Recover one interrupted archive transaction')
    modes.add_argument('--restore', action='store_true', help='Restore one completed archive without overwriting')
    args = parser.parse_args(argv)
    if (args.archive or args.recover or args.restore) and not args.release:
        parser.error('EXACTLY_ONE_RELEASE_REQUIRED')
    return args


def main(argv=None):
    args = parse_args(argv)
    archive.require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    task = Capacity08Archiver()
    if args.archive or args.recover or args.restore:
        result = task.archive(args.release) if args.archive else task.recover(args.release, restore=args.restore)
        result = commands(result)
    else:
        names = (args.release,) if args.release else ALLOW
        result = dict(mode='check-only', archive_directory=str(task.archives),
                      releases=[commands(task.check(name)[0]) for name in names])
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, tarfile.TarError) as error:
        raise SystemExit('CAPACITY08_ARCHIVE_REFUSED: ' + str(error))
