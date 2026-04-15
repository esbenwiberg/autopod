#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# start-dev.sh — Start the autopod daemon in dev mode
#
# Usage: ./scripts/start-dev.sh [options]
#
# Options:
#   --memory        Use in-memory SQLite (default: ~/.autopod/dev.db)
#   --mock-docker   Skip Docker; sessions won't run real containers
#   --port <n>      HTTP port (default: 3100)
#   --build         Force a build before starting
#   --help          Show this message
#
# Environment overrides:
#   AUTOPOD_MOCK_DOCKER=true   Same as --mock-docker
#   PORT=<n>                   Same as --port
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Colors (only when stdout is a terminal)
if [ -t 1 ]; then
  BOLD='\033[1m' GREEN='\033[0;32m' YELLOW='\033[0;33m' CYAN='\033[0;36m' NC='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' CYAN='' NC=''
fi

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ── Parse flags ───────────────────────────────────────────────────
PORT="${PORT:-3100}"
DB_PATH="$HOME/.autopod/dev.db"
MOCK_DOCKER="${AUTOPOD_MOCK_DOCKER:-false}"
DO_BUILD=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --memory)      DB_PATH=":memory:"; shift ;;
    --mock-docker) MOCK_DOCKER=true; shift ;;
    --port)        PORT="$2"; shift 2 ;;
    --build)       DO_BUILD=true; shift ;;
    --help|-h)     usage ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Build if needed ───────────────────────────────────────────────
if $DO_BUILD || [ ! -f "$ROOT/packages/daemon/dist/index.js" ]; then
  echo -e "${CYAN}Building daemon...${NC}"
  cd "$ROOT"
  npx pnpm --filter @autopod/daemon build
  echo -e "${GREEN}✓ Build complete${NC}"
fi

# ── Ensure dirs ───────────────────────────────────────────────────
mkdir -p "$HOME/.autopod"

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Autopod dev daemon${NC}"
echo -e "  Port:        ${CYAN}$PORT${NC}"
echo -e "  Database:    ${CYAN}$DB_PATH${NC}"
echo -e "  Mock Docker: ${CYAN}$MOCK_DOCKER${NC}"
echo -e "  Dev token:   ${CYAN}~/.autopod/dev-token${NC} (created on first run)"
echo ""

if [ "$MOCK_DOCKER" = "true" ]; then
  echo -e "${YELLOW}⚠ Mock Docker mode — sessions will not run real containers${NC}"
  echo ""
fi

# ── Start daemon ──────────────────────────────────────────────────
exec env \
  NODE_ENV=development \
  PORT="$PORT" \
  HOST=127.0.0.1 \
  DB_PATH="$DB_PATH" \
  LOG_LEVEL="${LOG_LEVEL:-debug}" \
  ENTRA_CLIENT_ID="${ENTRA_CLIENT_ID:-placeholder}" \
  ENTRA_TENANT_ID="${ENTRA_TENANT_ID:-placeholder}" \
  AUTOPOD_MOCK_DOCKER="$MOCK_DOCKER" \
  node "$ROOT/packages/daemon/dist/index.js"
