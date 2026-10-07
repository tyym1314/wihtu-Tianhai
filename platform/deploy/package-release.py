"""Package an immutable runtime release without local databases or credentials."""
import hashlib
import json
from pathlib import Path
import tarfile
import sys
from release_build import verify

repo = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]).resolve()
verify(repo)
files = set()
for relative in ['src', 'platform/server', 'platform/shared', 'platform/specs',
                 'platform/dist', 'platform/arena/dist', 'platform/legacy/dist',
                 'platform/deploy', 'platform/public/sdk',
                 'platform/specs/examples/partner-host/public']:
    files.update(p for p in (repo / relative).rglob('*') if p.is_file())
for name in ['package.json', 'package-lock.json', 'release-build-manifest.json', 'legacy/build-manifest.json', 'scripts/benchmark-release.mjs', 'scripts/benchmark-workload.mjs', 'scripts/benchmark-observer.mjs', 'scripts/benchmark-evaluation.mjs', 'scripts/android-game-actions.mjs']:
    files.add(repo / 'platform' / name)
# Engine code is loaded by Node. Media is already inside the prebuilt dist.
for directory in (repo / 'platform/arena').iterdir():
    if directory.is_dir() and directory.name != 'dist':
        files.update(directory.glob('*.mjs'))
        files.update(directory.glob('*.json'))
files = {p for p in files if not any(s in p.parts for s in ['.local', 'node_modules', '__pycache__'])
         and p.suffix not in ['.pem', '.key', '.pyc'] and not p.name.startswith('.env')}
manifest = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(files)}
out.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(out, 'w:gz') as archive:
    for p in sorted(files):
        archive.add(p, arcname=str(p.relative_to(repo)), recursive=False)
out.with_suffix(out.suffix + '.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'archive': str(out), 'files': len(files), 'bytes': out.stat().st_size,
                  'sha256': hashlib.sha256(out.read_bytes()).hexdigest()}))
