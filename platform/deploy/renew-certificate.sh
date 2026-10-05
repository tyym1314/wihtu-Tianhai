#!/bin/sh
set -eu
# The existing port-80 proxy has no host-mounted conf.d. Restore only our
# named ACME vhost if that container was recreated; never rewrite its config.
candidate=/opt/oasis/current/platform/deploy/oasis-acme-proxy.nginx.conf
if ! docker exec proxy-nginx test -f /etc/nginx/conf.d/oasis-acme.conf; then
    docker cp "$candidate" proxy-nginx:/etc/nginx/conf.d/oasis-acme.conf
    docker exec proxy-nginx nginx -t
    docker exec proxy-nginx nginx -s reload
fi
/opt/oasis/certbot/bin/certbot renew --non-interactive --quiet \
    --config-dir /opt/oasis/acme/config --work-dir /opt/oasis/acme/work \
    --logs-dir /opt/oasis/acme/logs --deploy-hook 'nginx -t && systemctl reload nginx'
