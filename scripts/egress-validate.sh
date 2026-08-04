#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# egress-validate.sh — Validate the HAProxy SNI egress firewall
#
# Builds the node22 base image, runs the firewall script in restricted
# mode against a known-allowed and known-denied SNI, and asserts:
#   - allowed SNI → TLS handshake completes
#   - denied SNI  → TCP reset
#   - port 80     → DROP (curl times out)
#
# Requires Docker. No-op (exits 0) when Docker is unavailable.
#
# Usage: ./scripts/egress-validate.sh
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  RED='\033[0;31m' GREEN='\033[0;32m' BOLD='\033[1m' NC='\033[0m'
else
  RED='' GREEN='' BOLD='' NC=''
fi

step() { echo -e "\n${BOLD}▸ $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; FAILED=1; }

if ! docker info >/dev/null 2>&1; then
  echo "Docker unavailable — skipping egress validation."
  exit 0
fi

IMAGE_TAG="autopod-egress-test:node22"
CONTAINER_NAME="autopod-egress-test"
FAILED=0

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Building node22 base image"
docker build -f templates/base/Dockerfile.node22 -t "$IMAGE_TAG" . >/dev/null
ok "Image built"

step "Starting test container"
# --cap-add NET_ADMIN so iptables works; --network=bridge for outbound;
# entrypoint just keeps the container alive while we run firewall + curls.
docker run -d --rm \
  --name "$CONTAINER_NAME" \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  "$IMAGE_TAG" sleep 300 >/dev/null
ok "Container started"

step "Generating firewall script via daemon module"
# Use the daemon's generator so the script under test matches production.
# Falls back to building shared+daemon if dist is stale.
SCRIPT=$(node -e "
import('./packages/daemon/dist/index.js').then(() => {}).catch(() => {});
" 2>/dev/null || true)

# Simplified: re-export the generator surface or call via a tiny inline script.
# For now, generate the script manually using node + the source modules.
node --experimental-vm-modules -e "
import('./packages/daemon/src/containers/docker-network-manager.js').then(async ({ DockerNetworkManager }) => {
  // Bypass the constructor's Dockerode dep — call generateFirewallScript directly off the prototype.
  const proto = DockerNetworkManager.prototype;
  const fakeLogger = { warn: () => {}, info: () => {}, child: () => fakeLogger };
  const inst = Object.create(proto);
  inst.logger = fakeLogger;
  const allowedHosts = ['api.anthropic.com', '*.blob.core.windows.net'];
  const script = await proto.generateFirewallScript.call(inst, allowedHosts, 'restricted');
  process.stdout.write(script);
}).catch((err) => {
  console.error('Failed to generate firewall script:', err.message);
  process.exit(1);
});
" > /tmp/firewall.sh 2>/dev/null || {
  echo "Failed to generate firewall script via the daemon module."
  echo "Ensure the daemon source is built: npx pnpm --filter @autopod/daemon build"
  exit 1
}
ok "Firewall script generated ($(wc -l < /tmp/firewall.sh) lines)"

step "Applying firewall inside container"
docker cp /tmp/firewall.sh "$CONTAINER_NAME":/tmp/firewall.sh
docker exec -u root "$CONTAINER_NAME" sh /tmp/firewall.sh >/dev/null 2>&1
ok "Firewall applied"

# Give HAProxy a moment to bind before exercising it.
sleep 1

step "Test 1: allowed SNI (api.anthropic.com) — should reach upstream"
HTTP_CODE=$(docker exec "$CONTAINER_NAME" \
  curl -sS -o /dev/null --connect-timeout 5 -w '%{http_code}' \
  https://api.anthropic.com/v1/models 2>&1 || true)
# 401 is fine — TLS handshake completed and the upstream rejected our auth.
# 000 means we never connected (would be a regression).
if [ "$HTTP_CODE" = "000" ]; then
  fail "Allowed SNI failed at the network layer (http_code=000)"
else
  ok "Allowed SNI reached upstream (http_code=$HTTP_CODE)"
fi

step "Test 2: denied SNI (evil.example.com) — should be rejected"
HTTP_CODE=$(docker exec "$CONTAINER_NAME" \
  curl -sS -o /dev/null --connect-timeout 5 -w '%{http_code}' \
  https://evil.example.com/ 2>&1 || true)
if [ "$HTTP_CODE" = "000" ]; then
  ok "Denied SNI rejected (no TLS handshake completed)"
else
  fail "Denied SNI unexpectedly succeeded (http_code=$HTTP_CODE)"
fi

step "Test 3: port 80 outbound — should be dropped"
# DROP means SYN goes nowhere; curl hangs until --max-time fires.
START=$(date +%s)
docker exec "$CONTAINER_NAME" \
  curl -sS -o /dev/null --max-time 3 \
  http://deb.debian.org/ >/dev/null 2>&1 || true
ELAPSED=$(( $(date +%s) - START ))
if [ "$ELAPSED" -ge 3 ]; then
  ok "Port 80 dropped (curl hit max-time)"
else
  fail "Port 80 not dropped — curl returned in ${ELAPSED}s"
fi

step "Test 4: HAProxy process is running"
if docker exec "$CONTAINER_NAME" pgrep -x haproxy >/dev/null 2>&1; then
  ok "HAProxy process alive"
else
  fail "HAProxy process not running"
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}Egress validation passed.${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}Egress validation failed.${NC}"
  echo ""
  echo "HAProxy config inside container:"
  docker exec "$CONTAINER_NAME" cat /etc/haproxy/haproxy.cfg 2>/dev/null | head -30 || true
  echo ""
  echo "iptables OUTPUT chain:"
  docker exec -u root "$CONTAINER_NAME" iptables -L OUTPUT -n -v 2>/dev/null | head -20 || true
  exit 1
fi
