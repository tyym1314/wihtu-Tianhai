"""Build an additive transfer against a verified release manifest; target is a full clone."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

repo = Path(__file__).resolve().parents[2]
old = json.loads(Path(sys.argv[1]).read_text())
old = old.get('files', old)
new_path = Path(sys.argv[2])
new = json.loads(new_path.read_text())
new = new.get('files', new)
out = Path(sys.argv[3])
changed = [name for name, digest in new.items() if old.get(name) != digest]
def runtime_permissions(entry):
    entry.mode = 0o755 if entry.mode & 0o111 else 0o644
    return entry
with tarfile.open(out, 'w:gz') as archive:
    for name in changed:
        path = repo / name
        if Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink() or not path.resolve().is_relative_to(repo):
            raise ValueError('UNSAFE_RELEASE_PATH')
        if hashlib.sha256(path.read_bytes()).hexdigest() != new[name]:
            raise ValueError('SOURCE_CHANGED_AFTER_MANIFEST: ' + name)
        archive.add(path, arcname=name, recursive=False, filter=runtime_permissions)
    archive.add(new_path, arcname='RELEASE-MANIFEST.json', recursive=False, filter=runtime_permissions)
print(json.dumps({'changed_files': len(changed), 'bytes': out.stat().st_size,
                  'sha256': hashlib.sha256(out.read_bytes()).hexdigest()}))
