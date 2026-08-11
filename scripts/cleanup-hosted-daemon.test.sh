#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
script="$root/cleanup-hosted-daemon.sh"
tmp="$(mktemp -d)"
tmp="$(realpath "$tmp")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/home/.autopod" "$tmp/worktrees" "$tmp/data/autopod/backups"
mkdir -p "$tmp/releases/deadbeef"
ln -s "$tmp/releases/deadbeef" "$tmp/current"
printf 'daemon: https://daemon.example\n' >"$tmp/home/.autopod/config.yaml"

mkdir -p "$tmp/worktrees/keep-explicit" "$tmp/worktrees/keep-active"
mkdir -p "$tmp/worktrees/delete-old" "$tmp/worktrees/keep-recent"
touch -t 202001010000 "$tmp/worktrees/keep-explicit" "$tmp/worktrees/keep-active" \
  "$tmp/worktrees/delete-old"

printf old >"$tmp/data/autopod/backups/old.db"
sleep 1
printf new >"$tmp/data/autopod/backups/new.db"

cat >"$tmp/bin/ap" <<'EOF'
#!/usr/bin/env bash
[ "$1" = token ] && echo token
EOF

cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *'/pods?'*) printf '[{"id":"active","status":"running","worktreePath":"%s"}]' "$CLEANUP_TEST_ACTIVE" ;;
  *'-X POST'*'hosted-deploy-drain'*)
    touch "$CLEANUP_TEST_DRAIN_POST"
    echo '{"active":{"expiresAt":"2099-01-01T00:00:00.000Z"}}'
    ;;
  *'-X DELETE'*'hosted-deploy-drain'*) touch "$CLEANUP_TEST_DRAIN_DELETE"; echo '{"active":null}' ;;
  *'/health'*) echo '{"status":"ok"}' ;;
  *) echo "unexpected curl: $*" >&2; exit 1 ;;
esac
EOF

cat >"$tmp/bin/az" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = account ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --scripts ]; then remote_script="$2"; break; fi
  shift
done
[ -n "${remote_script:-}" ] || { echo 'missing remote script' >&2; exit 1; }
sh -c "$remote_script"
EOF

cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  'image ls') echo dangling-image ;;
  'image prune') touch "$CLEANUP_TEST_DOCKER_PRUNE"; echo 'Total reclaimed space: 1GB' ;;
  'system df') echo 'Images 1 0 1GB 1GB' ;;
  *) echo "unexpected docker: $*" >&2; exit 1 ;;
esac
EOF

cat >"$tmp/bin/journalctl" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  --disk-usage) echo 'Archived and active journals take up 500M.' ;;
  --vacuum-size=*) touch "$CLEANUP_TEST_JOURNAL_VACUUM"; echo 'Vacuuming done.' ;;
  *) echo "unexpected journalctl: $*" >&2; exit 1 ;;
esac
EOF

cat >"$tmp/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[ "$1" = is-active ] && echo active
EOF

cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
# Force the helper's bounded rm fallback in the fixture.
exit 1
EOF

chmod +x "$tmp/bin"/*

run_cleanup() {
  PATH="$tmp/bin:$PATH" HOME="$tmp/home" \
    CLEANUP_TEST_ACTIVE="$tmp/worktrees/keep-active" \
    CLEANUP_TEST_DRAIN_POST="$tmp/drain-post" \
    CLEANUP_TEST_DRAIN_DELETE="$tmp/drain-delete" \
    CLEANUP_TEST_DOCKER_PRUNE="$tmp/docker-prune" \
    CLEANUP_TEST_JOURNAL_VACUUM="$tmp/journal-vacuum" \
    AUTOPOD_CLEANUP_WORKTREE_ROOT="$tmp/worktrees" \
    AUTOPOD_CLEANUP_DATA_ROOT="$tmp/data/autopod" \
    AUTOPOD_CLEANUP_CURRENT_LINK="$tmp/current" \
    AUTOPOD_CLEANUP_HEALTH_URL="https://daemon.example/health" \
    AUTOPOD_CLEANUP_DAEMON="https://daemon.example" \
    bash "$script" "$@"
}

# Dry-run reports candidates without mutating anything or taking the drain.
if ! run_cleanup --preserve-worktree keep-explicit >"$tmp/dry-run.out" 2>&1; then
  cat "$tmp/dry-run.out" >&2
  exit 1
fi
grep -qF 'mode:              DRY-RUN' "$tmp/dry-run.out"
grep -qF 'worktree candidates: 1' "$tmp/dry-run.out"
grep -qF 'snapshot candidates: 1' "$tmp/dry-run.out"
[ -d "$tmp/worktrees/delete-old" ]
[ -f "$tmp/data/autopod/backups/old.db" ]
[ ! -e "$tmp/docker-prune" ]
[ ! -e "$tmp/journal-vacuum" ]
[ ! -e "$tmp/drain-post" ]

# Apply protects explicit, active, and grace-period worktrees; removes the old
# terminal worktree and old snapshot; and releases the admission drain.
if ! run_cleanup --apply --yes --preserve-worktree keep-explicit >"$tmp/apply.out" 2>&1; then
  cat "$tmp/apply.out" >&2
  exit 1
fi
grep -qF 'CLEANUP_COMPLETE mode=apply' "$tmp/apply.out"
[ -d "$tmp/worktrees/keep-explicit" ]
[ -d "$tmp/worktrees/keep-active" ]
[ -d "$tmp/worktrees/keep-recent" ]
[ ! -e "$tmp/worktrees/delete-old" ]
[ -f "$tmp/data/autopod/backups/new.db" ]
[ ! -e "$tmp/data/autopod/backups/old.db" ]
[ -e "$tmp/docker-prune" ]
[ -e "$tmp/journal-vacuum" ]
[ -e "$tmp/drain-post" ]
[ -e "$tmp/drain-delete" ]

# Unsafe preservation names fail before Azure is called.
if run_cleanup --preserve-worktree '../escape' >"$tmp/unsafe.out" 2>&1; then
  echo 'unsafe preserve name unexpectedly accepted' >&2
  exit 1
fi
grep -qF 'invalid pod ID for --preserve-worktree' "$tmp/unsafe.out"

echo 'cleanup-hosted-daemon tests passed'
