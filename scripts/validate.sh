#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# validate.sh — "did I break it?" button
#
# Runs the full CI pipeline locally:
#   install → lint → build → typecheck → test → audit → secret-scan → (optional) smoke test
#
# Usage:
#   ./scripts/validate.sh           # full pipeline
#   ./scripts/validate.sh --quick   # skip install, run all checks
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
  if node scripts/run-pnpm.mjs install --frozen-lockfile 2>&1 | tail -3; then
    ok "Dependencies installed"
  else
    # Fallback without frozen lockfile (for local dev)
    warn "Frozen lockfile failed, trying regular install"
    node scripts/run-pnpm.mjs install 2>&1 | tail -3
  fi
fi

# ─── Lint ─────────────────────────────────────────────────────
step "Linting"
if node scripts/run-pnpm.mjs lint 2>&1; then
  ok "Lint passed"
else
  fail "Lint failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Build ────────────────────────────────────────────────────
step "Building"
if node scripts/run-pnpm.mjs build 2>&1; then
  ok "Build passed"
else
  fail "Build failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Test ─────────────────────────────────────────────────────
step "Typechecking"
if node scripts/run-pnpm.mjs typecheck 2>&1; then
  ok "Typecheck passed"
else
  fail "Typecheck failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Test ─────────────────────────────────────────────────────
step "Testing"
if node scripts/run-pnpm.mjs test 2>&1; then
  ok "Tests passed"
else
  fail "Tests failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Dependency Audit ─────────────────────────────────────────
step "Auditing dependencies"
if node scripts/run-pnpm.mjs audit --audit-level high 2>&1; then
  ok "Dependency audit passed"
else
  fail "Dependency audit failed"
  ERRORS=$((ERRORS + 1))
fi

# ─── Secret Scan ──────────────────────────────────────────────
step "Scanning secrets"
if node scripts/run-pnpm.mjs secret-scan 2>&1; then
  ok "Secret scan passed"
else
  fail "Secret scan failed"
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
