#!/bin/bash
# Starts Myelin in its container: Caddy for HTTPS in front of the Node server. Before either starts,
# the sandbox user is cut off from the network. The rest of its isolation comes from `docker run`
# (see packages/cli/src/deploy.ts): a read-only file system but for /tmp, and /data readable by
# root only.
set -euo pipefail

: "${MYELIN_DOMAIN:?MYELIN_DOMAIN must name the domain to get a certificate for}"
uid="${MYELIN_SANDBOX_UID:?}"

mkdir -p /data/myelin "$HOME" "$XDG_CONFIG_HOME"
chmod 700 /data "$HOME"

# No network for the sandbox user, not even the loopback the server listens on.
tables=(iptables)
[ -e /proc/net/if_inet6 ] && tables+=(ip6tables)
for t in "${tables[@]}"; do
  "$t" -C OUTPUT -m owner --uid-owner "$uid" -j DROP 2>/dev/null \
    || "$t" -A OUTPUT -m owner --uid-owner "$uid" -j DROP \
    || { echo "myelin: could not cut the sandbox off from the network with $t (the container needs NET_ADMIN)" >&2; exit 1; }
done
probe=$(setpriv --reuid="$uid" --regid="$uid" --clear-groups "$MYELIN_PYTHON" -c '
import socket
try:
    socket.create_connection(("1.1.1.1", 443), timeout=3)
    print("reached")
except OSError:
    print("blocked")' 2>&1) || true
if [ "$probe" != blocked ]; then
  echo "myelin: the sandbox user is not cut off from the network ($probe); not starting" >&2
  exit 1
fi

# Neither server keeps the power to change the firewall.
drop=(setpriv --inh-caps=-net_admin,-setpcap --bounding-set=-net_admin,-setpcap --)
"${drop[@]}" caddy run --config /app/deploy/Caddyfile --adapter caddyfile &
caddy=$!
"${drop[@]}" node /app/packages/cli/dist/main.js up --host 127.0.0.1 --port 4317 --name "${MYELIN_NAME:-me}" &
server=$!

stopping=0
trap 'stopping=1; kill -TERM "$caddy" "$server" 2>/dev/null || true' TERM INT
# When either stops, stop both. Docker starts the container again.
wait -n "$caddy" "$server" || true
kill -TERM "$caddy" "$server" 2>/dev/null || true
wait || true
[ "$stopping" = 1 ] && exit 0
echo "myelin: a server stopped; the container stops too" >&2
exit 1
