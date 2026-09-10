#!/usr/bin/env bash
# Focused regression checks for the hosted deployment admission fence.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/deploy-hosted-daemon.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.autopod"
mkdir -p "$tmp/releases/deadbeef/packages/daemon"
mkdir -p "$tmp/releases/cafebabe/packages/daemon/dist"
ln -s "$tmp/releases/deadbeef" "$tmp/current"
printf 'daemon: https://daemon.example\n' >"$tmp/home/.autopod/config.yaml"

cat >"$tmp/bin/ap" <<'EOF'
#!/usr/bin/env bash
echo token
EOF
cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fetch) exit 0 ;;
  rev-parse) echo cafebabecafebabecafebabecafebabecafebabe ;;
  cat-file) exit 0 ;;
  diff) exit 0 ;;
esac
EOF
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *'/pods'*) echo "${DEPLOY_TEST_PODS_JSON:-[]}" ;;
  *'hosted-deploy-drain'*)
    if [[ "$*" == *'-X DELETE'* ]]; then echo removed >"$DEPLOY_TEST_DRAIN_REMOVED"; fi
    echo '{"active":{"expiresAt":"2099-01-01T00:00:00.000Z"}}' ;;
  *'127.0.0.1:3100/health'*)
    count=$(cat "$DEPLOY_TEST_HEALTH_COUNT" 2>/dev/null || echo 0)
    count=$((count + 1)); echo "$count" >"$DEPLOY_TEST_HEALTH_COUNT"
    if [ "$count" -le "${DEPLOY_TEST_HEALTH_FAILURES:-0}" ]; then exit 7; fi
    echo '{"status":"ok"}'
    ;;
  *'/health'*)
    if [[ "$*" == *'%{http_code}'* ]]; then echo 200; exit 0; fi
    python3 - <<'PYRELEASE'
import json,os
mode=os.environ.get('DEPLOY_TEST_RELEASE_MODE','valid')
r={'commitSha':'cafebabecafebabecafebabecafebabecafebabe','dirty':False,'source':'build','validationImplementationHash':'a'*64}
if mode=='wrong':r['commitSha']='b'*40
if mode=='dirty':r['dirty']=True
if mode=='unavailable':r['validationImplementationHash']=None
print(json.dumps({'status':'ok',**({'release':r} if mode!='missing' else {})}))
PYRELEASE
    ;;
  *) echo 200 ;;
esac
EOF
cat >"$tmp/bin/az" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = account ]; then exit 0; fi
count_file="$DEPLOY_TEST_AZ_COUNT"
count=$(cat "$count_file" 2>/dev/null || echo 0)
count=$((count + 1)); echo "$count" >"$count_file"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --scripts ]; then remote_script="$2"; break; fi
  shift
done
[ -n "${remote_script:-}" ] || { echo 'missing remote script' >&2; exit 1; }
case "$remote_script" in
  *'echo live:'*) printf 'live:deadbeef\nactive\n' ;;
  *'BUILD DONE'*)
    if [[ "$remote_script" == *'copy current release'* ]]; then
      [[ "$remote_script" == *'bind target Git identity'* ]]
      [[ "$remote_script" == *'rm -rf "$NEW/.git"'* ]]
      [[ "$remote_script" == *'mv "$TMP/.git" "$NEW/.git"'* ]]
    fi
    echo 'BUILD DONE'
    ;;
  *'REVIEWER_CLI_PREWARM_OK'*) echo 'REVIEWER_CLI_PREWARM_OK' ;;
  *'VERIFY_MARKER='*) sh -c "$remote_script" ;;
  *'FINAL_ACTIVE='*)
    if [ "${DEPLOY_TEST_TRUNCATE_REMOTE:-0}" = 1 ]; then
      sh -c "$remote_script" | tail -c 512
    else
      sh -c "$remote_script"
    fi
    ;;
  *'keep_set='*) echo 'keep (protected): cafebabe' ;;
  *) echo "unexpected VM command $count" >&2; exit 1 ;;
esac
EOF
cat >"$tmp/bin/sudo" <<'EOF'
#!/usr/bin/env bash
echo "${DEPLOY_TEST_FINAL_ACTIVE:-0}"
EOF
cat >"$tmp/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = restart ]; then echo reached >"$DEPLOY_TEST_RESTART_MARKER"; fi
if [ "$1" = is-active ]; then echo active; fi
exit 0
EOF
cat >"$tmp/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$tmp/bin/ps" <<'EOF'
#!/usr/bin/env bash
echo "$AUTOPOD_DEPLOY_RELEASES/cafebabe/packages/daemon/dist/index.js"
EOF
cat >"$tmp/bin/journalctl" <<'EOF'
#!/usr/bin/env bash
if [ "${DEPLOY_TEST_TRUNCATE_REMOTE:-0}" = 1 ]; then
  i=0
  while [ "$i" -lt 100 ]; do
    echo 'long hosted journal entry that pushes earlier service state out of Azure Run Command output'
    i=$((i + 1))
  done
fi
exit 0
EOF
chmod +x "$tmp/bin"/*

run_deploy() {
  PATH="$tmp/bin:$PATH" HOME="$tmp/home" DEPLOY_TEST_AZ_COUNT="$tmp/az-count" \
    DEPLOY_TEST_RESTART_MARKER="$tmp/restarted" \
    AUTOPOD_DEPLOY_RELEASES="$tmp/releases" AUTOPOD_DEPLOY_CURRENT_LINK="$tmp/current" \
    DEPLOY_TEST_PODS_JSON="${DEPLOY_TEST_PODS_JSON:-[]}" \
    DEPLOY_TEST_FINAL_ACTIVE="${DEPLOY_TEST_FINAL_ACTIVE:-0}" \
    DEPLOY_TEST_HEALTH_COUNT="$tmp/health-count" \
    DEPLOY_TEST_HEALTH_FAILURES="${DEPLOY_TEST_HEALTH_FAILURES:-0}" \
    DEPLOY_TEST_TRUNCATE_REMOTE="${DEPLOY_TEST_TRUNCATE_REMOTE:-0}" \
    DEPLOY_TEST_RELEASE_MODE="${DEPLOY_TEST_RELEASE_MODE:-valid}" \
    DEPLOY_TEST_DRAIN_REMOVED="$tmp/drain-removed" \
    bash "$script" --target cafebabe --yes --skip-playwright-prewarm "$@"
}

reset_fixture() {
  ln -sfn "$tmp/releases/deadbeef" "$tmp/current"
  rm -f "$tmp/restarted" "$tmp/az-count" "$tmp/health-count" "$tmp/drain-removed"
}

# The first API snapshot is empty, but the atomic VM gate sees one pod just
# before restart. The same remote script must refuse before systemctl executes.
reset_fixture
if DEPLOY_TEST_FINAL_ACTIVE=1 run_deploy >"$tmp/out" 2>&1; then
  echo 'deployment unexpectedly passed despite a pod at the final restart gate' >&2
  exit 1
fi
grep -qF '1 active pod(s) at final restart gate — refusing deployment' "$tmp/out"
[ "$(cat "$tmp/az-count")" = 4 ]
[ ! -e "$tmp/restarted" ]

# Queued work has no running workload to interrupt. It must remain queued and
# must not block an ordinary daemon restart.
reset_fixture
if ! DEPLOY_TEST_PODS_JSON='[{"id":"queued-pod","status":"queued"}]' \
  run_deploy >"$tmp/queued-out" 2>&1; then
  cat "$tmp/queued-out" >&2
  exit 1
fi
grep -qF 'active (restart-blocking) pods: 0' "$tmp/queued-out"
grep -qF 'DEPLOYED deadbeef -> cafebabe' "$tmp/queued-out"
[ -e "$tmp/restarted" ]

# --force is explicit operator authorization to restart even when genuinely
# running work remains. It must warn at both snapshots and at the atomic gate.
reset_fixture
if ! DEPLOY_TEST_PODS_JSON='[{"id":"running-pod","status":"running"}]' \
  DEPLOY_TEST_FINAL_ACTIVE=1 run_deploy --force >"$tmp/force-out" 2>&1; then
  cat "$tmp/force-out" >&2
  exit 1
fi
grep -qF 'FORCE: 1 restart-blocking pod(s) still active after drain' "$tmp/force-out"
grep -qF 'FORCE: restarting with 1 active pod(s) at final gate' "$tmp/force-out"
grep -qF 'DEPLOYED deadbeef -> cafebabe' "$tmp/force-out"
[ -e "$tmp/restarted" ]

# Startup can legitimately take longer than one fixed sleep. The local health
# gate must retry boundedly before declaring the new release unhealthy.
reset_fixture
if ! DEPLOY_TEST_HEALTH_FAILURES=2 run_deploy >"$tmp/health-retry-out" 2>&1; then
  cat "$tmp/health-retry-out" >&2
  exit 1
fi
[ "$(cat "$tmp/health-count")" = 3 ]
grep -qF 'DEPLOYED deadbeef -> cafebabe' "$tmp/health-retry-out"

# Semantic verification must inspect emitted chunks and copied runtime helpers,
# while source maps alone cannot satisfy the deployed-code gate.
reset_fixture
printf 'const marker = "chunk-only-marker";\n' >"$tmp/releases/cafebabe/packages/daemon/dist/chunk-ABC.js"
printf 'source map mentions map-only-marker\n' >"$tmp/releases/cafebabe/packages/daemon/dist/index.js.map"
if ! run_deploy --verify-string chunk-only-marker >"$tmp/chunk-verify-out" 2>&1; then
  cat "$tmp/chunk-verify-out" >&2
  exit 1
fi
grep -qF 'bundle verify OK' "$tmp/chunk-verify-out"
reset_fixture
if run_deploy --verify-string map-only-marker >"$tmp/map-verify-out" 2>&1; then
  echo 'deployment incorrectly accepted a marker found only in a source map' >&2
  exit 1
fi
grep -qF 'expected string NOT in built bundle' "$tmp/map-verify-out"
[ ! -e "$tmp/restarted" ]

# Azure Run Command returns only a bounded output tail. Long journal lines must
# not push the authoritative service/health sentinels out of the returned text.
reset_fixture
if ! DEPLOY_TEST_TRUNCATE_REMOTE=1 run_deploy >"$tmp/truncated-out" 2>&1; then
  cat "$tmp/truncated-out" >&2
  exit 1
fi
grep -qF 'SERVICE_ACTIVE_OK' "$tmp/truncated-out"
grep -qF 'LOCAL_HEALTH_FINAL_OK' "$tmp/truncated-out"
grep -qF 'DEPLOYED deadbeef -> cafebabe' "$tmp/truncated-out"

# Source identity must be verified before releasing maintenance admission.
reset_fixture
if ! run_deploy --verify-release >"$tmp/release-valid-out" 2>&1; then
  cat "$tmp/release-valid-out" >&2
  exit 1
fi
grep -qF RELEASE_IDENTITY_OK "$tmp/release-valid-out"
[ -e "$tmp/drain-removed" ]
for mode in wrong dirty missing unavailable; do
  reset_fixture
  if DEPLOY_TEST_RELEASE_MODE="$mode" run_deploy --verify-release >"$tmp/release-$mode-out" 2>&1; then
    echo "deployment incorrectly accepted $mode release identity" >&2
    exit 1
  fi
  grep -qF 'release identity was not verified' "$tmp/release-$mode-out"
  [ -e "$tmp/restarted" ]
  [ ! -e "$tmp/drain-removed" ]
done
# A known pre-swap refusal can release the drain without opening a failed release.
reset_fixture
if DEPLOY_TEST_PODS_JSON='[{"status":"running"}]' run_deploy --verify-release >"$tmp/release-blocked-out" 2>&1; then exit 1; fi
[ ! -e "$tmp/restarted" ]
echo 'Hosted deployment release verification tests passed.'

# Staging performs build/readiness gates without activating or pruning a release.
reset_fixture
if ! run_deploy --stage-only >"$tmp/stage-only-out" 2>&1; then
  cat "$tmp/stage-only-out" >&2
  exit 1
fi
grep -qF 'STAGED cafebabe' "$tmp/stage-only-out"
[ ! -e "$tmp/restarted" ]
[ "$(readlink "$tmp/current")" = "$tmp/releases/deadbeef" ]
[ -e "$tmp/drain-removed" ]

# The config loader evaluates tsup.config while its generated sibling exists.
# That transient file must not mark a clean build dirty; actual source still must.
provenance="$tmp/provenance"
mkdir -p "$provenance/packages/daemon/src" "$provenance/packages/shared"
cp "$(dirname "$script")/../.gitignore" "$provenance/.gitignore"
printf 'export default {};\n' >"$provenance/packages/daemon/tsup.config.ts"
git -C "$provenance" init -q
git -C "$provenance" add .
git -C "$provenance" -c user.name=fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit -qm fixture
printf 'generated config\n' >"$provenance/packages/daemon/tsup.config.bundled_abc123.mjs"
printf 'parallel generated config\n' >"$provenance/packages/shared/tsup.config.bundled_xyz789.cjs"
[ -z "$(git -C "$provenance" status --porcelain -- packages)" ] || { echo 'generated config falsely marks release dirty' >&2; exit 1; }
printf 'real source\n' >"$provenance/packages/daemon/src/new-source.ts"
[ -n "$(git -C "$provenance" status --porcelain -- packages)" ]
rm "$provenance/packages/daemon/src/new-source.ts"
printf 'actual config change\n' >>"$provenance/packages/daemon/tsup.config.ts"
[ -n "$(git -C "$provenance" status --porcelain -- packages)" ]
echo 'Build provenance generated-file and real-source checks passed.'
