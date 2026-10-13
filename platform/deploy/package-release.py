"""Package an immutable runtime release without local databases or credentials."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import sys
from release_build import RETAINED_LOCK, is_local_metadata, verify, verify_retained_assets

def package(repo, out):
    verify(repo)
    retained = verify_retained_assets(repo)
    files = set()
    for relative in ['src', 'platform/server', 'platform/shared', 'platform/specs',
                     'platform/dist', 'platform/arena/dist', 'platform/legacy/dist',
                     'platform/deploy', 'platform/public/sdk',
                     'platform/specs/examples/partner-host/public']:
        files.update(p for p in (repo / relative).rglob('*') if p.is_file())
    for name in ['package.json', 'package-lock.json', 'release-build-manifest.json',
                 'legacy/build-manifest.json', 'scripts/benchmark-release.mjs',
                 'scripts/benchmark-workload.mjs', 'scripts/benchmark-observer.mjs',
                 'scripts/benchmark-evaluation.mjs', 'scripts/android-game-actions.mjs']:
        files.add(repo / 'platform' / name)
    # Engine code is loaded by Node. Media is already inside the prebuilt dist.
    for directory in (repo / 'platform/arena').iterdir():
        if directory.is_dir() and directory.name != 'dist':
            files.update(directory.glob('*.mjs'))
            files.update(directory.glob('*.json'))
    files = {p for p in files if not any(s in p.parts for s in ['.local', 'node_modules', '__pycache__', 'private', 'secrets'])
             and p.suffix not in ['.pem', '.key', '.pyc'] and not p.name.startswith('.env')}
    files.add(repo / RETAINED_LOCK)
    for path in files:
        relative = path.relative_to(repo)
        if (any((repo / parent).is_symlink() for parent in (relative, *relative.parents))
                or not path.resolve().is_relative_to(repo.resolve())):
            raise ValueError('UNSAFE_RELEASE_PATH: ' + str(path.relative_to(repo)))
    # Keep the existing symlink rejection even for newly excluded metadata.
    def is_deploy_test_or_mock(path):
        relative = path.relative_to(repo)
        return (relative.parts[:2] == ('platform', 'deploy')
                and ('mock-sandbox' in relative.parts or 'fixtures' in relative.parts
                     or path.name.startswith('test_') or '.test.' in path.name))

    files = {p for p in files if not is_local_metadata(p.relative_to(repo))
             and not is_deploy_test_or_mock(p)}
    manifest = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(files)}
    for asset in retained['assets']:
        if manifest.get(asset['path']) != asset['sha256']:
            raise ValueError('RETAINED_ASSET_MISSING_FROM_RELEASE: ' + asset['path'])
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
    out.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out, 'w:gz') as archive:
        for path in sorted(files):
            name = str(path.relative_to(repo))
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() != manifest[name]:
                raise ValueError('SOURCE_CHANGED_AFTER_MANIFEST: ' + name)
            entry = archive.gettarinfo(str(path), arcname=name)
            if not entry.isfile():
                raise ValueError('UNSAFE_RELEASE_PATH: ' + name)
            # Builds may run under umask 077. Runtime files contain no credentials
            # and must remain readable by the dedicated API and Nginx users.
            entry.mode = 0o755 if entry.mode & 0o111 else 0o644
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
        # The manifest names business files only, avoiding a self-hash recursion.
        entry = tarfile.TarInfo('RELEASE-MANIFEST.json')
        entry.size = len(manifest_bytes)
        entry.mode = 0o644
        archive.addfile(entry, io.BytesIO(manifest_bytes))
    out.with_suffix(out.suffix + '.manifest.json').write_bytes(manifest_bytes)
    return {'archive': str(out), 'files': len(files), 'bytes': out.stat().st_size,
            'sha256': hashlib.sha256(out.read_bytes()).hexdigest()}


if __name__ == '__main__':
    repo = Path(__file__).resolve().parents[2]
    out = Path(sys.argv[1]).resolve()
    print(json.dumps(package(repo, out)))
