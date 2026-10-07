#!/usr/bin/env python3
"""Reversibly archive exactly two inactive releases for the capacity batch.

This independent batch permanently retains its verified tar files. It reuses the
existing Archiver protocol without changing the original nine-release allowlist,
archive directory, metadata or Restic recovery material. No offsite backup is
claimed. The default is a read-only check of the selected release or both releases.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tarfile


_dependency = Path(__file__).with_name('archive-releases.py')
_spec = importlib.util.spec_from_file_location('capacity_archive_protocol', _dependency)
archive = importlib.util.module_from_spec(_spec)
exec(compile(_dependency.read_bytes(), str(_dependency), 'exec'), archive.__dict__)

ALLOW = ('20261004-01', '20261008-01')
ARCHIVE_DIRECTORY = 'release-archives-capacity-20261008'
TOOL = 'archive-capacity-releases.py'


class CapacityArchiver(archive.Archiver):
    def __init__(self, base=Path('/opt/oasis'), proc=Path('/proc'), reserve=archive.RESERVE):
        super().__init__(base, proc, reserve)
        self.archives = self.base / ARCHIVE_DIRECTORY

    def paths(self, name):
        archive.require(name in ALLOW, 'RELEASE_NOT_ALLOWLISTED')
        return self.releases / name, self.archives / ('.work-' + name), self.archives / name

    def archive_identity(self, folder, name):
        super().archive_identity(folder, name)
        state = folder / 'storage.json'
        archive.require(not state.exists() and not state.is_symlink(), 'CAPACITY_TAR_RETIREMENT_NOT_SUPPORTED')


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
    task = CapacityArchiver()
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
        raise SystemExit('CAPACITY_ARCHIVE_REFUSED: ' + str(error))
