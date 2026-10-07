#!/usr/bin/env python3
"""Reversibly archive exactly three inactive releases for the capacity07 batch.

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
"""
import argparse
import builtins
from contextlib import contextmanager
import hashlib
import types
import importlib.util
import json
import os
from pathlib import Path
import tarfile


_dependency = Path(__file__).with_name('archive-releases.py')
_spec = importlib.util.spec_from_file_location('capacity07_archive_protocol', _dependency)
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


release_build = adjacent_module('capacity07_release_build', 'release_build.py')
publisher = adjacent_module('capacity07_static_publisher', 'publish-static-assets.py',
                            {'release_build': release_build})

ALLOW = ('20260922-04', '20260926-01', '20261008-02')
ARCHIVE_DIRECTORY = 'release-archives-capacity07-20261008'
TOOL = 'archive-capacity07-releases.py'


class Capacity07Archiver(archive.Archiver):
    def __init__(self, base=Path('/opt/oasis'), proc=Path('/proc'), reserve=archive.RESERVE):
        super().__init__(base, proc, reserve)
        self.archives = self.base / ARCHIVE_DIRECTORY
        self._release = None
        self._coverage_report = None

    @contextmanager
    def release_scope(self, name):
        archive.require(name in ALLOW, 'RELEASE_NOT_ALLOWLISTED')
        archive.require(self._release in (None, name), 'AMBIGUOUS_CAPACITY07_OPERATION')
        previous = self._release
        if previous is None:
            self._coverage_report = None
        self._release = name
        try:
            yield
        finally:
            self._release = previous

    def check(self, name):
        with self.release_scope(name):
            report, before = super().check(name)
            report['static_coverage'] = self._coverage_report
            return report, before

    def archive(self, name):
        with self.release_scope(name):
            result = super().archive(name)
            return dict(result, static_coverage=self._coverage_report)

    def recover(self, name, restore=False):
        with self.release_scope(name):
            result = super().recover(name, restore=restore)
            return dict(result, static_coverage=self._coverage_report)

    def coverage_tree(self, snapshot_data):
        # At inherited coverage checkpoints the complete tree is either still
        # live in releases, quarantined, or freshly unpacked for recovery.
        # Prefer the actual recovery tree over its older quarantined original.
        archive.require(self._release in ALLOW, 'CAPACITY07_RELEASE_CONTEXT_REQUIRED')
        source, work, final = self.paths(self._release)
        roots = (source, work / 'recovery' / self._release, final / 'recovery' / self._release,
                 work / 'original', final / 'original')
        for root in roots:
            if root.exists() or root.is_symlink():
                archive.directory(root)
                path = release_build.regular_path(root, 'RELEASE-MANIFEST.json')
                entry = snapshot_data['entries'].get('RELEASE-MANIFEST.json', {})
                archive.require(entry.get('type') == 'file' and archive.digest(path) == entry.get('sha256'),
                                'CAPACITY07_MANIFEST_CHANGED')
                archive.verify_manifest(root, snapshot_data)
                return root
        raise ValueError('CAPACITY07_COVERAGE_TREE_MISSING')

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
                            'CAPACITY07_MANIFEST_CHANGED')
            for name, entry in missing.items():
                public = release_build.static_public_path(name)
                item = declared.get(public, {})
                archive.require(item.get('source') == name and item.get('sha256') == entry['sha256']
                                and item.get('bytes') == entry['size'], 'CAPACITY07_UNDECLARED_GLOBAL_ASSET')
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
        archive.require(not state.exists() and not state.is_symlink(), 'CAPACITY07_TAR_RETIREMENT_NOT_SUPPORTED')


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
    task = Capacity07Archiver()
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
        raise SystemExit('CAPACITY07_ARCHIVE_REFUSED: ' + str(error))
