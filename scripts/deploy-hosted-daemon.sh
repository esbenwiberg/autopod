#!/usr/bin/env bash
#
# deploy-hosted-daemon.sh — deploy a commit to the hosted Autopod daemon VM.
#
# The hosted daemon runs on an Azure VM (resource group ewi-sandboxes, VM
# autopod-daemon) behind Caddy. There is NO SSH; all remote work goes through
# `az vm run-command invoke`. Releases live at /opt/autopod/releases/<sha> and
# /opt/autopod/current is a symlink the systemd unit `autopod-daemon` runs from.
#
# This script automates the deploy dance (preflight → build new release on the
# VM → prewarm Playwright → verify the built bundle → atomic symlink swap →
# post-verify → print rollback → prune). See the `deploy-hosted-daemon` skill
# for the runbook and judgment that wraps it.
#
# Usage:
#   scripts/deploy-hosted-daemon.sh [--target <sha|ref>] [--yes] [--force]
#                                   [--full] [--keep N] [--verify-string STR]
#                                   [--skip-playwright-prewarm]
#   scripts/deploy-hosted-daemon.sh --rollback <sha>
#
#   --target <sha|ref>   Commit/ref to deploy (default: origin/main HEAD).
#   --yes                Skip the confirm-before-swap prompt (CI / unattended).
#   --force              Override guards (active pods present, target == live).
#   --full               Force clean clone + full `pnpm install` (no node_modules
#                        reuse). Auto-selected when deps changed or live sha is
#                        not present locally.
#   --keep N             Releases to retain when pruning (default: 5).
#   --verify-string STR  Extra gate: grep the flattened built bundle for STR
#                        before swapping (catches "built the wrong thing").
#   --skip-playwright-prewarm
#                        Emergency escape hatch: do not install/launch-check the
#                        daemon Playwright Chromium browser before swapping.
#   --rollback <sha>     Repoint current -> releases/<sha> + restart. Nothing else.
#
# Gotchas baked in (learned the hard way):
#   - VM run-command shell is `sh`, not bash: no pipefail, build runs via
#     `sudo -u ewi -H bash -lc` with absolute paths (run-command cwd is unstable).
#   - node_modules reuse (cp -a current) is ONLY valid when deps are unchanged;
#     a package.json / pnpm-lock.yaml change forces --full.
#   - Verification greps the BUILT bundle (newlines flattened), never source and
#     never a comment — comments get stripped by the bundler.
#   - Host browser validation needs both OS libraries and an `ewi`-owned
#     Playwright browser cache. Deploys prewarm and launch-check daemon Chromium
#     before swapping so browser validation cannot come up half-ready.
#
set -euo pipefail

# ---- config ---------------------------------------------------------------
RG="ewi-sandboxes"
VM="autopod-daemon"
REPO_URL="https://github.com/esbenwiberg/autopod.git"
RELEASES="/opt/autopod/releases"
CURRENT_LINK="/opt/autopod/current"
SERVICE="autopod-daemon"
HEALTH_URL="https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/health"
SERVICE_USER="ewi"
SYSTEMD_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CLAUDE_CLI_NPM_PACKAGE="${CLAUDE_CLI_NPM_PACKAGE:-@anthropic-ai/claude-code}"
CODEX_CLI_NPM_PACKAGE="${CODEX_CLI_NPM_PACKAGE:-@openai/codex}"
# Non-terminal pod statuses == "active"; we refuse to restart on top of these.
NONTERMINAL="queued provisioning running validating validated approved merging merge_pending killing"

# ---- args -----------------------------------------------------------------
TARGET_REF=""
ASSUME_YES=0
FORCE=0
FULL=0
KEEP=5
VERIFY_STRING=""
ROLLBACK_SHA=""
PREWARM_PLAYWRIGHT=1

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET_REF="${2:-}"; shift 2;;
    --yes|-y) ASSUME_YES=1; shift;;
    --force) FORCE=1; shift;;
    --full) FULL=1; shift;;
    --keep) KEEP="${2:-}"; shift 2;;
    --verify-string) VERIFY_STRING="${2:-}"; shift 2;;
    --skip-playwright-prewarm) PREWARM_PLAYWRIGHT=0; shift;;
    --rollback) ROLLBACK_SHA="${2:-}"; shift 2;;
    -h|--help) sed -n '2,40p' "$0"; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

command -v az >/dev/null || die "az CLI not found"
az account show >/dev/null 2>&1 || die "az not logged in — run: az login"
case "$CLAUDE_CLI_NPM_PACKAGE" in
  *[!A-Za-z0-9@._/-]*|'') die "invalid CLAUDE_CLI_NPM_PACKAGE: $CLAUDE_CLI_NPM_PACKAGE";;
esac
case "$CODEX_CLI_NPM_PACKAGE" in
  *[!A-Za-z0-9@._/-]*|'') die "invalid CODEX_CLI_NPM_PACKAGE: $CODEX_CLI_NPM_PACKAGE";;
esac

# Run a script block on the VM, returning its captured stdout/stderr message.
remote() {
  az vm run-command invoke -g "$RG" -n "$VM" --command-id RunShellScript \
    --scripts "$1" --query "value[0].message" -o tsv 2>&1
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---- rollback mode (short-circuit) ---------------------------------------
if [ -n "$ROLLBACK_SHA" ]; then
  note "ROLLBACK -> $ROLLBACK_SHA"
  out="$(remote "
set -eu
[ -d $RELEASES/$ROLLBACK_SHA ] || { echo 'MISSING_RELEASE'; exit 1; }
prev=\$(readlink $CURRENT_LINK)
ln -sfn $RELEASES/$ROLLBACK_SHA $CURRENT_LINK
echo \"current: \$prev -> \$(readlink $CURRENT_LINK)\"
systemctl restart $SERVICE
sleep 6
echo \"active: \$(systemctl is-active $SERVICE)\"
curl -sS --max-time 8 http://127.0.0.1:3100/health || echo HEALTH_FAIL
")"
  echo "$out"
  echo "$out" | grep -q MISSING_RELEASE && die "release $ROLLBACK_SHA not on VM"
  curl -sS --max-time 10 "$HEALTH_URL" >/dev/null && note "external HTTPS health OK" || die "external health FAILED post-rollback"
  note "rollback done"
  exit 0
fi

# ---- resolve target + live ------------------------------------------------
note "fetching origin"
git fetch -q origin

if [ -z "$TARGET_REF" ]; then TARGET_REF="origin/main"; fi
TARGET_SHA_FULL="$(git rev-parse "$TARGET_REF" 2>/dev/null)" || die "cannot resolve target ref: $TARGET_REF"
TARGET_SHA="${TARGET_SHA_FULL:0:8}"

note "discovering live release on VM"
LIVE_LINE="$(remote "echo live:\$(basename \$(readlink $CURRENT_LINK)); systemctl is-active $SERVICE")"
LIVE_SHA="$(printf '%s\n' "$LIVE_LINE" | sed -n 's/^live://p' | tr -d '[:space:]')"
[ -n "$LIVE_SHA" ] || die "could not read live release sha from VM:\n$LIVE_LINE"

note "live=$LIVE_SHA  target=$TARGET_SHA ($TARGET_REF)"

if [ "$LIVE_SHA" = "$TARGET_SHA" ] && [ "$FORCE" -eq 0 ]; then
  die "live release already at $TARGET_SHA — nothing to deploy (use --force to redeploy)"
fi

# ---- decide overlay (fast) vs full clone ----------------------------------
DEPS_CHANGED=0
LIVE_KNOWN=0
if git cat-file -e "${LIVE_SHA}^{commit}" 2>/dev/null; then
  LIVE_KNOWN=1
  if ! git diff --quiet "$LIVE_SHA" "$TARGET_SHA_FULL" -- '**/package.json' 'package.json' 'pnpm-lock.yaml' 2>/dev/null; then
    DEPS_CHANGED=1
  fi
fi

if [ "$LIVE_KNOWN" -eq 0 ]; then
  note "live sha $LIVE_SHA not present locally — forcing --full (cannot compute a safe overlay)"
  FULL=1
elif [ "$DEPS_CHANGED" -eq 1 ]; then
  note "package.json / pnpm-lock.yaml changed between live and target — forcing --full install"
  FULL=1
fi

# Changed + deleted source files (overlay mode only).
CHANGED_FILES=""
DELETED_FILES=""
if [ "$FULL" -eq 0 ]; then
  CHANGED_FILES="$(git diff --name-only --diff-filter=ACMRT "$LIVE_SHA" "$TARGET_SHA_FULL")"
  DELETED_FILES="$(git diff --name-only --diff-filter=D "$LIVE_SHA" "$TARGET_SHA_FULL")"
  CHANGED_COUNT="$(printf '%s\n' "$CHANGED_FILES" | grep -c . || true)"
  note "overlay mode: $CHANGED_COUNT changed file(s), $(printf '%s\n' "$DELETED_FILES" | grep -c . || true) deleted"
else
  note "full mode: clean clone of $TARGET_SHA + pnpm install on the VM"
fi

# ---- preflight: active pods ----------------------------------------------
note "checking for active pods"
TOKEN="$(ap token 2>/dev/null || true)"
DAEMON="$(grep -E '^daemon:' "$HOME/.autopod/config.yaml" | awk '{print $2}')"
if [ -n "$TOKEN" ] && [ -n "$DAEMON" ]; then
  ACTIVE="$(curl -sS --max-time 10 "$DAEMON/pods" -H "Authorization: Bearer $TOKEN" 2>/dev/null \
    | NONTERMINAL="$NONTERMINAL" python3 -c '
import sys, json, os
nt = set(os.environ["NONTERMINAL"].split())
try:
    d = json.load(sys.stdin)
except Exception:
    print("?"); sys.exit(0)
pods = d if isinstance(d, list) else d.get("pods", d.get("items", []))
print(sum(1 for p in pods if isinstance(p, dict) and p.get("status") in nt))
' 2>/dev/null || echo '?')"
  note "active (non-terminal) pods: $ACTIVE"
  if [ "$ACTIVE" != "0" ] && [ "$ACTIVE" != "?" ] && [ "$FORCE" -eq 0 ]; then
    die "$ACTIVE active pod(s) — restart would interrupt them (use --force to override)"
  fi
  [ "$ACTIVE" = "?" ] && note "WARN: could not parse pod list; proceeding (verify manually)"
else
  note "WARN: no token/daemon URL — skipping active-pods preflight"
fi

# ---- confirm --------------------------------------------------------------
echo
echo "  DEPLOY PLAN"
echo "  VM:        $RG/$VM"
echo "  live:      $LIVE_SHA"
echo "  target:    $TARGET_SHA  ($TARGET_REF)"
echo "  mode:      $([ "$FULL" -eq 1 ] && echo 'FULL (clone + install)' || echo 'overlay (reuse node_modules)')"
echo "  browser:   $([ "$PREWARM_PLAYWRIGHT" -eq 1 ] && echo 'prewarm + launch-check daemon Playwright Chromium' || echo 'SKIPPED')"
echo "  reviewer:  ensure claude + codex CLIs for hosted review paths"
echo "  rollback:  scripts/deploy-hosted-daemon.sh --rollback $LIVE_SHA"
echo
if [ "$ASSUME_YES" -eq 0 ]; then
  printf "Proceed? [y/N] "
  read -r ans
  case "$ans" in y|Y|yes) ;; *) die "aborted by user";; esac
fi

NEW="$RELEASES/$TARGET_SHA"
TMP="/tmp/autopod-deploy-$TARGET_SHA"

# ---- build new release on the VM (no swap yet) ---------------------------
note "building release $TARGET_SHA on the VM (this can take a while)"

if [ "$FULL" -eq 1 ]; then
  BUILD_SCRIPT="
set -eu
NEW=$NEW
TMP=$TMP
run_and_tail() {
  log=\"\$1\"
  lines=\"\$2\"
  shift 2
  if ! \"\$@\" >\"\$log\" 2>&1; then
    tail -n 80 \"\$log\" || true
    exit 1
  fi
  tail -n \"\$lines\" \"\$log\" || true
}
echo '=== clean clone of target ==='
sudo -u ewi rm -rf \"\$TMP\"
run_and_tail /tmp/autopod-clone-$TARGET_SHA.log 2 sudo -u ewi git clone --no-checkout '$REPO_URL' \"\$TMP\"
run_and_tail /tmp/autopod-fetch-$TARGET_SHA.log 1 sudo -u ewi git -C \"\$TMP\" fetch --depth 1 origin $TARGET_SHA_FULL
sudo -u ewi git -C \"\$TMP\" checkout -q $TARGET_SHA_FULL
echo \"checked out: \$(sudo -u ewi git -C \"\$TMP\" rev-parse HEAD)\"
echo '=== install + build (all packages) ==='
run_and_tail /tmp/autopod-build-$TARGET_SHA.log 24 sudo -u ewi -H bash -lc \"cd \$TMP && npx --yes pnpm install --frozen-lockfile && npx --yes pnpm build\"
echo '=== stage as new release ==='
rm -rf \"\$NEW\"
mv \"\$TMP\" \"\$NEW\"
chown -R ewi:ewi \"\$NEW\"
ls -la \"\$NEW/packages/daemon/dist/index.js\"
echo '=== BUILD DONE (symlink NOT swapped) ==='
"
else
  # Overlay mode: reuse current release's node_modules, overlay changed source.
  BUILD_SCRIPT="
set -eu
SRC=$RELEASES/$LIVE_SHA
NEW=$NEW
TMP=$TMP
run_and_tail() {
  log=\"\$1\"
  lines=\"\$2\"
  shift 2
  if ! \"\$@\" >\"\$log\" 2>&1; then
    tail -n 80 \"\$log\" || true
    exit 1
  fi
  tail -n \"\$lines\" \"\$log\" || true
}
echo '=== copy current release (reuses node_modules) ==='
rm -rf \"\$NEW\"
cp -a \"\$SRC\" \"\$NEW\"
echo '=== fetch target source ==='
sudo -u ewi rm -rf \"\$TMP\"
run_and_tail /tmp/autopod-clone-$TARGET_SHA.log 1 sudo -u ewi git clone --no-checkout '$REPO_URL' \"\$TMP\"
run_and_tail /tmp/autopod-fetch-$TARGET_SHA.log 1 sudo -u ewi git -C \"\$TMP\" fetch --depth 1 origin $TARGET_SHA_FULL
sudo -u ewi git -C \"\$TMP\" checkout -q $TARGET_SHA_FULL
echo \"target source: \$(sudo -u ewi git -C \"\$TMP\" rev-parse HEAD)\"
echo '=== overlay changed files ==='
while IFS= read -r f; do
  [ -z \"\$f\" ] && continue
  mkdir -p \"\$NEW/\$(dirname \"\$f\")\"
  cp \"\$TMP/\$f\" \"\$NEW/\$f\"
done <<'CHANGED_EOF'
$CHANGED_FILES
CHANGED_EOF
echo '=== remove deleted files ==='
while IFS= read -r f; do
  [ -z \"\$f\" ] && continue
  rm -f \"\$NEW/\$f\"
done <<'DELETED_EOF'
$DELETED_FILES
DELETED_EOF
chown -R ewi:ewi \"\$NEW\"
echo '=== rebuild (turbo rebuilds only changed packages) ==='
run_and_tail /tmp/autopod-build-$TARGET_SHA.log 24 sudo -u ewi -H bash -lc \"cd \$NEW && npx --yes pnpm build\"
sudo -u ewi rm -rf \"\$TMP\"
ls -la \"\$NEW/packages/daemon/dist/index.js\"
echo '=== BUILD DONE (symlink NOT swapped) ==='
"
fi

BUILD_OUT="$(remote "$BUILD_SCRIPT")"
echo "$BUILD_OUT"
echo "$BUILD_OUT" | grep -q "BUILD DONE" || die "build did not complete — see output above; symlink untouched"

# ---- prewarm reviewer CLIs (no swap yet) ---------------------------------
note "ensuring hosted reviewer CLIs are installed on the VM"
REVIEWER_CLI_SCRIPT="
set -eu
SERVICE=$SERVICE
SERVICE_USER=$SERVICE_USER
SYSTEMD_PATH='$SYSTEMD_PATH'
CLAUDE_CLI_NPM_PACKAGE='$CLAUDE_CLI_NPM_PACKAGE'
CODEX_CLI_NPM_PACKAGE='$CODEX_CLI_NPM_PACKAGE'

command -v npm >/dev/null 2>&1 || { echo NPM_MISSING; exit 1; }

ensure_npm_cli() {
  name=\"\$1\"
  package=\"\$2\"
  upper=\"\$(printf '%s' \"\$name\" | tr '[:lower:]' '[:upper:]')\"

  if ! PATH=\"\$SYSTEMD_PATH\" command -v \"\$name\" >/dev/null 2>&1; then
    echo \"=== installing \$name from \$package ===\"
    npm install -g \"\$package\"
  fi

  if ! PATH=\"\$SYSTEMD_PATH\" command -v \"\$name\" >/dev/null 2>&1; then
    global_bin=\"\$(npm prefix -g)/bin/\$name\"
    discovered=\"\$(command -v \"\$name\" 2>/dev/null || true)\"
    if [ -x \"\$global_bin\" ]; then
      ln -sfn \"\$global_bin\" \"/usr/local/bin/\$name\"
    elif [ -n \"\$discovered\" ] && [ -x \"\$discovered\" ]; then
      ln -sfn \"\$discovered\" \"/usr/local/bin/\$name\"
    fi
  fi

  resolved=\"\$(PATH=\"\$SYSTEMD_PATH\" command -v \"\$name\" 2>/dev/null || true)\"
  [ -n \"\$resolved\" ] || { echo \"\${upper}_CLI_MISSING\"; exit 1; }

  echo \"\$name: \$resolved\"
  version_log=\"/tmp/autopod-\$name-version.log\"
  if ! sudo -u \"\$SERVICE_USER\" -H env PATH=\"\$SYSTEMD_PATH\" \"\$resolved\" --version >\"\$version_log\" 2>&1; then
    if ! sudo -u \"\$SERVICE_USER\" -H env PATH=\"\$SYSTEMD_PATH\" \"\$resolved\" --help >\"\$version_log\" 2>&1; then
      tail -n 20 \"\$version_log\" || true
      echo \"\${upper}_CLI_UNRUNNABLE_AS_\$SERVICE_USER\"
      exit 1
    fi
  fi
  head -n 1 \"\$version_log\" || true
}

ensure_npm_cli claude \"\$CLAUDE_CLI_NPM_PACKAGE\"
ensure_npm_cli codex \"\$CODEX_CLI_NPM_PACKAGE\"

echo '=== OpenRouter support ==='
if systemctl show \"\$SERVICE\" -p Environment 2>/dev/null | grep -q 'OPENROUTER_API_KEY'; then
  echo 'OPENROUTER_API_KEY is configured in the service environment'
else
  echo 'OPENROUTER_API_KEY not found in the service environment; per-profile OpenRouter credentials still work'
fi
echo REVIEWER_CLI_PREWARM_OK
"
REVIEWER_CLI_OUT="$(remote "$REVIEWER_CLI_SCRIPT")"
echo "$REVIEWER_CLI_OUT"
echo "$REVIEWER_CLI_OUT" | grep -q "REVIEWER_CLI_PREWARM_OK" || die "reviewer CLI prewarm failed — symlink untouched"

# ---- prewarm host browser cache (no swap yet) -----------------------------
if [ "$PREWARM_PLAYWRIGHT" -eq 1 ]; then
  note "prewarming daemon Playwright Chromium on the VM"
  PREWARM_SCRIPT="
set -eu
NEW=$NEW
run_and_tail() {
  log=\"\$1\"
  lines=\"\$2\"
  shift 2
  if ! \"\$@\" >\"\$log\" 2>&1; then
    tail -n 80 \"\$log\" || true
    exit 1
  fi
  tail -n \"\$lines\" \"\$log\" || true
}
cd \"\$NEW/packages/daemon\"
[ -x ./node_modules/.bin/playwright ] || { echo PLAYWRIGHT_BIN_MISSING; exit 1; }
echo '=== install Playwright Linux dependencies ==='
run_and_tail /tmp/autopod-playwright-deps-$TARGET_SHA.log 24 ./node_modules/.bin/playwright install-deps chromium
echo '=== install daemon Chromium into ewi cache ==='
run_and_tail /tmp/autopod-playwright-browser-$TARGET_SHA.log 24 sudo -u ewi -H bash -lc \"cd \$NEW/packages/daemon && ./node_modules/.bin/playwright install chromium\"
echo '=== launch-check daemon Chromium as ewi ==='
sudo -u ewi -H bash -lc \"cd \$NEW/packages/daemon && node -e 'const { chromium } = require(\\\"playwright\\\"); const { existsSync } = require(\\\"fs\\\"); (async () => { const p = chromium.executablePath(); console.log(\\\"chromium=\\\" + p); if (!existsSync(p)) { throw new Error(\\\"missing Chromium executable\\\"); } const browser = await chromium.launch({ headless: true }); await browser.close(); })().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });'\"
echo PLAYWRIGHT_PREWARM_OK
"
  PREWARM_OUT="$(remote "$PREWARM_SCRIPT")"
  echo "$PREWARM_OUT"
  echo "$PREWARM_OUT" | grep -q "PLAYWRIGHT_PREWARM_OK" || die "Playwright prewarm failed — symlink untouched"
else
  note "skipping Playwright Chromium prewarm (--skip-playwright-prewarm)"
fi

# ---- verify built bundle (optional semantic gate) -------------------------
if [ -n "$VERIFY_STRING" ]; then
  note "verifying built bundle contains: $VERIFY_STRING"
  VOUT="$(remote "
NEW=$NEW/packages/daemon/dist/index.js
if tr '\n' ' ' < \"\$NEW\" | grep -qF -- '$VERIFY_STRING'; then echo VERIFY_OK; else echo VERIFY_MISSING; fi
")"
  echo "$VOUT" | grep -q VERIFY_OK || die "expected string NOT in built bundle — refusing swap. Rollback unaffected (current still $LIVE_SHA)."
  note "bundle verify OK"
fi

# ---- atomic swap + restart ------------------------------------------------
note "swapping symlink + restarting $SERVICE"
SWAP_OUT="$(remote "
set -eu
echo \"prev: \$(readlink $CURRENT_LINK)\"
ln -sfn $NEW $CURRENT_LINK
echo \"now:  \$(readlink $CURRENT_LINK)\"
systemctl restart $SERVICE
sleep 6
echo \"active: \$(systemctl is-active $SERVICE)\"
echo \"running on: \$(ps -o args= -C node | grep -o '$RELEASES/[^/]*' | head -1)\"
curl -sS --max-time 8 http://127.0.0.1:3100/health || echo HEALTH_FAIL
echo '--- journal tail ---'
journalctl -u $SERVICE -n 12 --no-pager 2>&1 | tail -12
")"
echo "$SWAP_OUT"

# ---- post-verify ----------------------------------------------------------
echo "$SWAP_OUT" | grep -q "active: active" || die "service not active after restart — ROLL BACK: scripts/deploy-hosted-daemon.sh --rollback $LIVE_SHA"
echo "$SWAP_OUT" | grep -q "HEALTH_FAIL" && die "local /health failed — ROLL BACK: scripts/deploy-hosted-daemon.sh --rollback $LIVE_SHA"

note "checking external HTTPS health"
HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$HEALTH_URL" || echo 000)"
[ "$HTTP_CODE" = "200" ] || die "external health returned $HTTP_CODE — investigate (Caddy?). ROLL BACK: scripts/deploy-hosted-daemon.sh --rollback $LIVE_SHA"
note "external HTTPS health 200 OK"

# ---- prune old releases ---------------------------------------------------
note "pruning old releases (keep $KEEP, never current or previous-live)"
PRUNE_OUT="$(remote "
set -eu
cur=\$(basename \$(readlink $CURRENT_LINK))
keep_set=\" \$cur $LIVE_SHA \"
i=0
for d in \$(ls -1dt $RELEASES/*/ 2>/dev/null); do
  name=\$(basename \"\$d\")
  case \"\$keep_set\" in *\" \$name \"*) echo \"keep (protected): \$name\"; continue;; esac
  i=\$((i+1))
  if [ \"\$i\" -gt $KEEP ]; then echo \"prune: \$name\"; rm -rf \"\$d\"; else echo \"keep: \$name\"; fi
done
")"
echo "$PRUNE_OUT"

echo
note "DEPLOYED $LIVE_SHA -> $TARGET_SHA"
echo "  rollback if needed:  scripts/deploy-hosted-daemon.sh --rollback $LIVE_SHA"
