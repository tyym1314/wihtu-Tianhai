#!/bin/sh
set -eu
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination=/opt/oasis/backups/$stamp
mkdir "$destination"
docker exec oasis-postgres pg_dump -U oasis -d oasis_platform -Fc >"$destination/database.dump"
# Offsite envelopes already contain an earlier private archive. Repacking them
# recursively would make each daily backup include all previous backup payloads.
tar --exclude=private/offsite -czf "$destination/private-config.tar.gz" -C /opt/oasis private
readlink -f /opt/oasis/current >"$destination/release.txt"
docker exec -i oasis-postgres pg_restore --list <"$destination/database.dump" >"$destination/database-contents.txt"
(cd "$destination" && sha256sum database.dump private-config.tar.gz release.txt >SHA256SUMS)
echo "OASIS backup completed: $destination"
