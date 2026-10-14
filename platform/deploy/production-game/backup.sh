#!/bin/sh
# Daily production backup: database dumps + the private key/config needed to restore them.
# Release-independent: deployments do not break it. Restore needs database.dump AND master.key.
set -eu
umask 077
DEST=/opt/oasis/production-backups
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP="$DEST/.building-$TS"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
dump() { docker exec oasis-production-postgres sh -c "pg_dump -U \"\$POSTGRES_USER\" -d $1 --format=custom --no-owner --no-acl"; }
dump oasis_production > "$TMP/database.dump"
head -c 5 "$TMP/database.dump" | grep -q PGDMP
if docker exec oasis-production-postgres sh -c "psql -U \"\$POSTGRES_USER\" -d oasis_production -tAc \"SELECT 1 FROM pg_database WHERE datname='oasis_demo_partner_wallet'\"" | grep -q 1; then
  dump oasis_demo_partner_wallet > "$TMP/demo-partner-wallet.dump"
fi
docker exec -i oasis-production-postgres pg_restore --list < "$TMP/database.dump" > "$TMP/database-contents.txt"
test -s "$TMP/database-contents.txt"
set -- production-instance-private/state/master.key production-instance-private/runtime.env production-instance-private/postgres.env
for f in partner-demo/config.json partner-demo/env; do [ -f "/opt/oasis/$f" ] && set -- "$@" "$f"; done
tar -czf "$TMP/private-config.tar.gz" -C /opt/oasis "$@"
readlink -f /opt/oasis/production-current > "$TMP/release.txt"
(cd "$TMP" && sha256sum -- * > SHA256SUMS)
mv -T "$TMP" "$DEST/$TS"
trap - EXIT
printf '{"backup":"%s","database_bytes":%s}\n' "$DEST/$TS" "$(stat -c %s "$DEST/$TS/database.dump")"
