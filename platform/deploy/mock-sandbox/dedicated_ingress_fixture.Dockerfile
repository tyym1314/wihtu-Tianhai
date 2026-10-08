# Disposable synthetic Linux fixture only, never a deployment/runtime image.
# Run --network none, no binds/devices/privileged or security-policy bypass.
# Setup cap subset only: CHOWN,DAC_OVERRIDE,FOWNER,KILL,SETGID,SETUID.
# Every Nginx child drops UID/GID to 2345 and all usable capabilities to zero.
FROM debian:bookworm-slim
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 nginx openssl \
    && rm -rf /var/lib/apt/lists/* \
    && printf 'oasis-rootless-dedicated-ingress-v1\n' > /fixture-marker
WORKDIR /capsule
COPY dedicated_ingress.py dedicated_ingress_fixture.py mock.nginx.conf.example /capsule/
RUN chmod 0555 /capsule && chmod 0444 /capsule/* /fixture-marker
ENV OASIS_DEDICATED_INGRESS_FIXTURE=oasis-rootless-dedicated-ingress-v1
ENTRYPOINT ["/usr/bin/python3", "-B", "/capsule/dedicated_ingress_fixture.py"]
