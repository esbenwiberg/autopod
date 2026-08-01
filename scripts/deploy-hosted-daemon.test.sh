#!/usr/bin/env bash
# Focused regression checks for the hosted deployment admission fence.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/deploy-hosted-daemon.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.autopod"
mkdir -p "$tmp/releases/deadbeef/packages/daemon"
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
  *'/pods'*) echo '[]' ;;
  *'hosted-deploy-drain'*) echo '{"active":{"expiresAt":"2099-01-01T00:00:00.000Z"}}' ;;
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
  *'BUILD DONE'*) echo 'BUILD DONE' ;;
  *'REVIEWER_CLI_PREWARM_OK'*) echo 'REVIEWER_CLI_PREWARM_OK' ;;
  *'FINAL_ACTIVE='*) sh -c "$remote_script" ;;
  *) echo "unexpected VM command $count" >&2; exit 1 ;;
esac
EOF
cat >"$tmp/bin/sudo" <<'EOF'
#!/usr/bin/env bash
# Simulate the VM database query observing a pod admitted after the API check.
echo 1
EOF
cat >"$tmp/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = restart ]; then echo reached >"$DEPLOY_TEST_RESTART_MARKER"; fi
exit 0
EOF
chmod +x "$tmp/bin"/*

# The first API snapshot is empty, but the atomic VM gate sees one pod just
# before restart. The same remote script must refuse before systemctl executes.
if PATH="$tmp/bin:$PATH" HOME="$tmp/home" DEPLOY_TEST_AZ_COUNT="$tmp/az-count" \
  DEPLOY_TEST_RESTART_MARKER="$tmp/restarted" \
  AUTOPOD_DEPLOY_RELEASES="$tmp/releases" AUTOPOD_DEPLOY_CURRENT_LINK="$tmp/current" \
  bash "$script" --target cafebabe --yes --skip-playwright-prewarm >"$tmp/out" 2>&1; then
  echo 'deployment unexpectedly passed despite a pod at the final restart gate' >&2
  exit 1
fi
rg -q '1 active pod\(s\) at final restart gate — refusing deployment' "$tmp/out"
[ "$(cat "$tmp/az-count")" = 4 ]
[ ! -e "$tmp/restarted" ]
