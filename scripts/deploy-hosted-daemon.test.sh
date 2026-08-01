#!/usr/bin/env bash
# Focused regression checks for the hosted deployment admission fence.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/deploy-hosted-daemon.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.autopod"
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
case "$count" in
  1) printf 'live:deadbeef\nactive\n' ;;
  2) echo 'BUILD DONE' ;;
  3) echo 'REVIEWER_CLI_PREWARM_OK' ;;
  4) echo 1 ;;
  *) echo "unexpected VM command $count" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin"/*

# The first API snapshot is empty, but the immediate VM gate sees one pod. A
# real deployment must stop before it can issue the remote restart command.
if PATH="$tmp/bin:$PATH" HOME="$tmp/home" DEPLOY_TEST_AZ_COUNT="$tmp/az-count" \
  bash "$script" --target cafebabe --yes --skip-playwright-prewarm >"$tmp/out" 2>&1; then
  echo 'deployment unexpectedly passed despite a pod at the final restart gate' >&2
  exit 1
fi
rg -q '1 active pod\(s\) at final restart gate — refusing deployment' "$tmp/out"
[ "$(cat "$tmp/az-count")" = 4 ]
