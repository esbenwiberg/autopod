#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# validate.sh — "did I break it?" button
#
# Runs the full CI pipeline locally:
#   install → lint → build → test → (optional) smoke test
#
# Usage:
#   ./scripts/validate.sh           # full pipeline
#   ./scripts/validate.sh --quick   # skip install, lint only changed
#   ./scripts/validate.sh --smoke   # also run daemon smoke test
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Colors (if terminal supports them)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BOLD='' NC=''
fi

step() { echo -e "\n${BOLD}▸ $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }

QUICK=false
SMOKE=false
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=true ;;
    --smoke) SMOKE=true ;;
  esac
done

ERRORS=0

# ─── Install ──────────────────────────────────────────────────
if [ "$QUICK" = false ]; then
  step "Installing dependencies"
  if npx pnpm install --frozen-lockfile 2>&1 | tail -3; then
    ok "Dependencies installed"
  else
    # Fallback without frozen lockfile (for local dev)
    warn "Frozen lockfile failed, trying regular install"
    npx pnpm install 2>&1 | tail -3
  fi
fi

# ─── Lint ─────────────────────────────────────────────────────
step "Linting"
if npx pnpm lint 2>&1; then
  ok "Lint passed"
else
  fail "Lint failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Build ────────────────────────────────────────────────────
step "Building"
if npx pnpm build 2>&1; then
  ok "Build passed"
else
  fail "Build failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Test ─────────────────────────────────────────────────────
step "Testing"
if npx pnpm test 2>&1; then
  ok "Tests passed"
else
  fail "Tests failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Smoke Test (optional) ───────────────────────────────────
if [ "$SMOKE" = true ]; then
  step "Daemon smoke test"
  if [ -f "$ROOT/scripts/smoke-test.sh" ]; then
    if "$ROOT/scripts/smoke-test.sh"; then
      ok "Smoke test passed"
    else
      fail "Smoke test failed"
      ERRORS=$((ERRORS + 1))
    fi
  else
    warn "scripts/smoke-test.sh not found, skipping"
  fi
fi

# ─── Summary ─────────────────────────────────────────────────
echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All checks passed.${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${ERRORS} check(s) failed.${NC}"
  exit 1
fi
