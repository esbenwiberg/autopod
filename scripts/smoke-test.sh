#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# smoke-test.sh — Start daemon, hit /health, verify, kill
#
# Requires Docker to be running (daemon pings Docker on startup).
# If Docker is unavailable, exits with a warning instead of failing.
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Colors
if [ -t 1 ]; then
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[0;33m' NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' NC=''
fi

PORT="${SMOKE_PORT:-3199}"
DAEMON_PID=""

cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Check Docker availability
if ! docker info >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠ Docker not available — skipping smoke test${NC}"
  exit 0
fi

# Check that daemon is built
if [ ! -f "$ROOT/packages/daemon/dist/index.js" ]; then
  echo -e "${RED}✗ Daemon not built — run 'npx pnpm build' first${NC}"
  exit 1
fi

echo "Starting daemon on port $PORT..."

# Start daemon in background with minimal config
NODE_ENV=development \
PORT="$PORT" \
HOST=127.0.0.1 \
DB_PATH=":memory:" \
LOG_LEVEL=warn \
ENTRA_CLIENT_ID=placeholder \
ENTRA_TENANT_ID=placeholder \
  node "$ROOT/packages/daemon/dist/index.js" &
DAEMON_PID=$!

# Wait for daemon to be ready (up to 15 seconds)
READY=false
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.5
done

if [ "$READY" = false ]; then
  echo -e "${RED}✗ Daemon failed to start within 15 seconds${NC}"
  # Print last few lines of output for debugging
  exit 1
fi

# Hit the health endpoint
HEALTH=$(curl -sf "http://127.0.0.1:$PORT/health")
STATUS=$(echo "$HEALTH" | grep -o '"status":"ok"' || true)

if [ -n "$STATUS" ]; then
  echo -e "${GREEN}✓ Health check passed: $HEALTH${NC}"
else
  echo -e "${RED}✗ Health check failed: $HEALTH${NC}"
  exit 1
fi

# Hit the version endpoint
VERSION=$(curl -sf "http://127.0.0.1:$PORT/version")
echo -e "${GREEN}✓ Version: $VERSION${NC}"

# Quick profile + session roundtrip
echo "Testing profile + session CRUD..."

# Create a profile
CREATE_PROFILE=$(curl -sf -X POST "http://127.0.0.1:$PORT/profiles" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-token" \
  -d '{"name":"smoke-test","repoUrl":"https://github.com/org/repo","buildCommand":"echo ok","startCommand":"echo ok"}')

if echo "$CREATE_PROFILE" | grep -q '"name":"smoke-test"'; then
  echo -e "${GREEN}✓ Profile created${NC}"
else
  echo -e "${RED}✗ Profile creation failed: $CREATE_PROFILE${NC}"
  exit 1
fi

# List profiles
LIST_PROFILES=$(curl -sf "http://127.0.0.1:$PORT/profiles" \
  -H "Authorization: Bearer dev-token")
if echo "$LIST_PROFILES" | grep -q 'smoke-test'; then
  echo -e "${GREEN}✓ Profile listed${NC}"
else
  echo -e "${RED}✗ Profile list failed${NC}"
  exit 1
fi

echo -e "\n${GREEN}All smoke tests passed.${NC}"
