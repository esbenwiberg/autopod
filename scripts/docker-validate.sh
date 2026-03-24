#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# docker-validate.sh — Validate the Docker deployment artifact
#
# Builds the production image, starts it via docker compose,
# runs health checks and API smoke tests, then tears everything down.
#
# Usage:
#   ./scripts/docker-validate.sh          # full validation
#   ./scripts/docker-validate.sh --dev    # use dev Dockerfile instead
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Colors
if [ -t 1 ]; then
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[0;33m' BOLD='\033[1m' NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BOLD='' NC=''
fi

step() { echo -e "\n${BOLD}▸ $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }

USE_DEV=false
for arg in "$@"; do
  case "$arg" in
    --dev) USE_DEV=true ;;
  esac
done

# Check Docker availability
if ! docker info >/dev/null 2>&1; then
  echo -e "${RED}✗ Docker not available — cannot run Docker validation${NC}"
  exit 1
fi

COMPOSE_PROJECT="autopod-validate"
ERRORS=0

cleanup() {
  step "Cleaning up"
  docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans 2>/dev/null || true
  ok "Containers removed"
}
trap cleanup EXIT

# ─── Build Image ──────────────────────────────────────────────
if [ "$USE_DEV" = true ]; then
  step "Building dev image"
  docker build -f Dockerfile.daemon.dev -t autopod-validate:dev . 2>&1 | tail -5
  ok "Dev image built"
else
  step "Building production image"
  docker build -t autopod-validate:latest . 2>&1 | tail -5
  ok "Production image built"
fi

# ─── Start Container ─────────────────────────────────────────
step "Starting daemon container"

PORT=3198
IMAGE_TAG="autopod-validate:latest"
[ "$USE_DEV" = true ] && IMAGE_TAG="autopod-validate:dev"

docker run -d \
  --name "${COMPOSE_PROJECT}-daemon" \
  -p "${PORT}:3000" \
  -e PORT=3000 \
  -e HOST=0.0.0.0 \
  -e DB_PATH=/data/autopod.db \
  -e LOG_LEVEL=warn \
  -e NODE_ENV=development \
  -e ENTRA_CLIENT_ID=placeholder \
  -e ENTRA_TENANT_ID=placeholder \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$IMAGE_TAG" >/dev/null

ok "Container started"

# ─── Health Check ─────────────────────────────────────────────
step "Waiting for daemon health check"

READY=false
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done

if [ "$READY" = false ]; then
  fail "Daemon failed to start within 30 seconds"
  echo "Container logs:"
  docker logs "${COMPOSE_PROJECT}-daemon" 2>&1 | tail -20
  ERRORS=$((ERRORS + 1))
else
  HEALTH=$(curl -sf "http://127.0.0.1:$PORT/health")
  ok "Health check passed: $HEALTH"
fi

# ─── API Smoke Tests ─────────────────────────────────────────
step "Running API smoke tests"

# Version endpoint
VERSION=$(curl -sf "http://127.0.0.1:$PORT/version")
if echo "$VERSION" | grep -q '"version"'; then
  ok "Version endpoint: $VERSION"
else
  fail "Version endpoint failed"
  ERRORS=$((ERRORS + 1))
fi

# Create profile
PROFILE=$(curl -sf -X POST "http://127.0.0.1:$PORT/profiles" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-token" \
  -d '{"name":"docker-test","repoUrl":"https://github.com/org/repo","buildCommand":"echo ok","startCommand":"echo ok"}')
if echo "$PROFILE" | grep -q '"name":"docker-test"'; then
  ok "Profile creation"
else
  fail "Profile creation failed: $PROFILE"
  ERRORS=$((ERRORS + 1))
fi

# List profiles
PROFILES=$(curl -sf "http://127.0.0.1:$PORT/profiles" \
  -H "Authorization: Bearer dev-token")
if echo "$PROFILES" | grep -q 'docker-test'; then
  ok "Profile listing"
else
  fail "Profile listing failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Summary ─────────────────────────────────────────────────
echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}Docker validation passed.${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${ERRORS} check(s) failed.${NC}"
  echo "Container logs:"
  docker logs "${COMPOSE_PROJECT}-daemon" 2>&1 | tail -30
  exit 1
fi
