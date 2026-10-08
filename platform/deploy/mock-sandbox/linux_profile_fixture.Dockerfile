# Only build/run for the documented private fixture. Not a deployment image.
FROM debian:bookworm-slim
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 nginx util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/conf.d/*.conf \
    && printf 'oasis-private-linux-profile-v1\n' > /fixture-marker
WORKDIR /capsule
COPY profile_activation.py install.py upgrade.py route_profile.py asset_store.py asset_routes.py asset_bundle.py linux_profile_fixture.py /capsule/
RUN chmod 0644 /capsule/*.py
ENV OASIS_PROFILE_LINUX_FIXTURE=oasis-private-linux-profile-v1
ENTRYPOINT ["/usr/bin/python3", "-B", "/capsule/linux_profile_fixture.py"]
