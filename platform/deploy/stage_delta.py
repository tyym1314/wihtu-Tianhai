#!/usr/bin/env python3
"""Stage a verified transfer delta as a new, independent Oasis release.

The current release is copied rather than hard-linked. This keeps rollback
files immutable when a changed file is written into the candidate directory.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile

BASE = Path('/opt/oasis')


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def files_in(manifest):
    if isinstance(manifest, dict) and isinstance(manifest.get('files'), dict):
        manifest = manifest['files']
    if not isinstance(manifest, dict) or len(manifest) < 10:
        raise ValueError('INVALID_RELEASE_MANIFEST')
    for name, value in manifest.items():
        path = PurePosixPath(name)
        if (not isinstance(name, str) or not name or path.is_absolute()
                or '..' in path.parts or path.as_posix() != name
                or not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value)):
            raise ValueError('UNSAFE_RELEASE_MANIFEST')
    return manifest


def verify_tree(root, manifest):
    for name, expected in manifest.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('UNSAFE_RELEASE_PATH: ' + name)
        if digest(path) != expected:
            raise ValueError('RELEASE_HASH_MISMATCH: ' + name)


def stage(base, candidate, archive, expected_sha256):
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha256):
        raise ValueError('INVALID_DELTA_SHA256')
    if not base.is_dir() or candidate.exists() or candidate.is_symlink():
        raise ValueError('INVALID_RELEASE_LOCATION')
    if digest(archive) != expected_sha256:
        raise ValueError('DELTA_HASH_MISMATCH')
    old = files_in(json.loads((base / 'RELEASE-MANIFEST.json').read_text()))
    with tarfile.open(archive, 'r:gz') as bundle:
        entries = bundle.getmembers()
        names = [entry.name for entry in entries]
        if len(names) != len(set(names)) or 'RELEASE-MANIFEST.json' not in names:
            raise ValueError('INVALID_DELTA_ENTRIES')
        for entry in entries:
            path = PurePosixPath(entry.name)
            if (not entry.isfile() or path.is_absolute() or '..' in path.parts
                    or path.as_posix() != entry.name):
                raise ValueError('UNSAFE_DELTA_ENTRY')
        new = files_in(json.load(bundle.extractfile('RELEASE-MANIFEST.json')))
        changed = {name for name, expected in new.items() if old.get(name) != expected}
        if set(names) - {'RELEASE-MANIFEST.json'} != changed:
            raise ValueError('DELTA_MANIFEST_MISMATCH')
        for entry in entries:
            if entry.name != 'RELEASE-MANIFEST.json':
                if hashlib.sha256(bundle.extractfile(entry).read()).hexdigest() != new[entry.name]:
                    raise ValueError('DELTA_ENTRY_HASH_MISMATCH: ' + entry.name)
        try:
            shutil.copytree(base, candidate, symlinks=True)
            for entry in entries:
                if entry.name == 'RELEASE-MANIFEST.json':
                    continue
                path = candidate / entry.name
                if path.is_symlink() or not path.resolve().is_relative_to(candidate.resolve()):
                    raise ValueError('UNSAFE_RELEASE_PATH: ' + entry.name)
                parent = path.parent
                while parent != candidate:
                    if parent.is_symlink():
                        raise ValueError('UNSAFE_RELEASE_PARENT: ' + entry.name)
                    parent = parent.parent
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(bundle.extractfile(entry).read())
                path.chmod(entry.mode & 0o777)
            (candidate / 'RELEASE-MANIFEST.json').write_text(json.dumps(new, indent=2) + '\n')
            verify_tree(candidate, new)
        except Exception:
            if candidate.exists():
                shutil.rmtree(candidate)
            raise
    return {'previous': str(base), 'candidate': str(candidate),
            'verified_files': len(new), 'changed_files': len(changed),
            'delta_sha256': expected_sha256}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release_name', help='New directory name below /opt/oasis/releases')
    parser.add_argument('archive', type=Path)
    parser.add_argument('sha256')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]{8}-[0-9]{2}', args.release_name):
        raise ValueError('INVALID_RELEASE_NAME')
    base = (BASE / 'current').resolve(strict=True)
    if base.parent != BASE / 'releases':
        raise ValueError('INVALID_CURRENT_RELEASE')
    candidate = BASE / 'releases' / args.release_name
    print(json.dumps(stage(base, candidate, args.archive, args.sha256)))


if __name__ == '__main__':
    main()
