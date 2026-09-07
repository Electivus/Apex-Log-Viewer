#!/usr/bin/env sh
set -eu

# Extend the image's trusted roots with the operator's approved corporate CA
# bundle. Both upstream TLS verification and the lab's MITM controls stay on.
if [ -f /run/alv-upstream-ca.pem ]; then
  cat /etc/ssl/certs/ca-certificates.crt /run/alv-upstream-ca.pem > /tmp/alv-upstream-ca-bundle.pem
  set -- --set ssl_verify_upstream_trusted_ca=/tmp/alv-upstream-ca-bundle.pem
fi

exec mitmdump --set confdir=/mitmproxy --set stream_large_bodies=1m \
  --listen-host 0.0.0.0 --listen-port 8888 \
  --proxyauth alv-proxy-user:alv-proxy-pass "$@"
