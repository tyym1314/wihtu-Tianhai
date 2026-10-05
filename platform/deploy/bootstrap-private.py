"""Fresh remote instance only. Generate secrets without printing them."""
from pathlib import Path
import os
import secrets

root = Path('/opt/oasis/private')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
database = root / 'postgres.env'
runtime = root / 'runtime.env'
if database.exists() or runtime.exists():
    raise SystemExit('Private configuration already exists; refusing to rotate it')
password = secrets.token_hex(32)
database.write_text(f'POSTGRES_USER=oasis\nPOSTGRES_DB=oasis_platform\nPOSTGRES_PASSWORD={password}\n')
runtime.write_text('\n'.join([
    'NODE_ENV=production',
    'OASIS_PUBLIC_ORIGIN=https://game.tianyahuyu.com',
    f'OASIS_DATABASE_URL=postgres://oasis:{password}@127.0.0.1:18883/oasis_platform',
    'OASIS_API_PORT=18881', 'OASIS_WALLET_PORT=18882', 'OASIS_DEMO_PORT=18885',
    'OASIS_REFERENCE_WALLET_URL=http://127.0.0.1:18882',
    'OASIS_TRUST_LOOPBACK_PROXY=1', 'OASIS_LOCAL_DIR=/opt/oasis/private/state/',
    ''
]))
for p in [database, runtime]:
    os.chmod(p, 0o600)
print('Created fresh private database and application configuration.')
