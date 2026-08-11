#!/bin/sh
# VM-side implementation for cleanup-hosted-daemon.sh. Not intended to be
# invoked directly by operators.
set -eu

: "${APPLY:?}"
: "${WORKTREE_ROOT:?}"
: "${DATA_ROOT:?}"
: "${CURRENT_LINK:?}"
: "${SERVICE:?}"
: "${SNAPSHOT_RETAIN:?}"
: "${JOURNAL_SIZE:?}"
: "${MIN_AGE_MINUTES:?}"
: "${SKIP_DOCKER:?}"
: "${SKIP_WORKTREES:?}"
: "${SKIP_SNAPSHOTS:?}"
: "${SKIP_JOURNALS:?}"
: "${PRESERVE_NAMES_B64:=}"

fail() { echo "REMOTE ERROR: $*" >&2; exit 1; }

path_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

path_bytes() {
  if [ -f "$1" ]; then
    stat -c %s "$1" 2>/dev/null || stat -f %z "$1"
  else
    kib="$(du -sk "$1" | awk '{print $1}')"
    echo "$((kib * 1024))"
  fi
}

case "$APPLY$SKIP_DOCKER$SKIP_WORKTREES$SKIP_SNAPSHOTS$SKIP_JOURNALS" in
  *[!01]*) fail "boolean cleanup setting was not 0 or 1";;
esac
case "$SNAPSHOT_RETAIN" in *[!0-9]*|'') fail "invalid snapshot retention";; esac
[ "$SNAPSHOT_RETAIN" -ge 1 ] || fail "snapshot retention must be at least 1"
case "$MIN_AGE_MINUTES" in *[!0-9]*|'') fail "invalid worktree grace period";; esac
journal_number="${JOURNAL_SIZE%[KMG]}"
journal_suffix="${JOURNAL_SIZE#"$journal_number"}"
case "$journal_number" in *[!0-9]*|'') fail "invalid journal size";; esac
case "$journal_suffix" in K|M|G) ;; *) fail "invalid journal size";; esac

case "$WORKTREE_ROOT" in /|/home|/home/*/.autopod|'') fail "unsafe worktree root: $WORKTREE_ROOT";; esac
[ "${WORKTREE_ROOT##*/}" = worktrees ] || fail "worktree root must end in /worktrees"
case "$DATA_ROOT" in /|/data|'') fail "unsafe data root: $DATA_ROOT";; esac
[ "${DATA_ROOT##*/}" = autopod ] || fail "data root must end in /autopod"

preserve_file="$(mktemp /tmp/autopod-preserve.XXXXXX)"
worktree_candidates="$(mktemp /tmp/autopod-worktrees.XXXXXX)"
snapshot_order="$(mktemp /tmp/autopod-snapshots.XXXXXX)"
snapshot_candidates="$(mktemp /tmp/autopod-snapshot-delete.XXXXXX)"
trap 'rm -f "$preserve_file" "$worktree_candidates" "$snapshot_order" "$snapshot_candidates"' EXIT
if ! printf '%s' "$PRESERVE_NAMES_B64" | base64 -d >"$preserve_file" 2>/dev/null; then
  printf '%s' "$PRESERVE_NAMES_B64" | base64 -D >"$preserve_file"
fi

echo "=== disk before ==="
df -h /
echo "active release: $(readlink "$CURRENT_LINK")"
echo "service: $(systemctl is-active "$SERVICE")"
echo "releases: protected and out of scope"

if [ "$SKIP_DOCKER" -eq 0 ]; then
  dangling_count="$(docker image ls --filter dangling=true -q | sort -u | wc -l | tr -d ' ')"
  echo "dangling Docker images: $dangling_count"
  docker system df || true
  if [ "$APPLY" -eq 1 ]; then
    docker image prune -f
  fi
fi

if [ "$SKIP_WORKTREES" -eq 0 ]; then
  [ -d "$WORKTREE_ROOT" ] || fail "worktree root missing: $WORKTREE_ROOT"
  [ "$(realpath "$WORKTREE_ROOT")" = "$WORKTREE_ROOT" ] \
    || fail "worktree root is not canonical: $WORKTREE_ROOT"
  now="$(date +%s)"
  cutoff="$((now - MIN_AGE_MINUTES * 60))"
  find "$WORKTREE_ROOT" -mindepth 1 -maxdepth 1 -type d -print | sort \
    | while IFS= read -r directory; do
        [ -L "$directory" ] && fail "refusing symlinked worktree: $directory"
        name="${directory##*/}"
        if grep -Fx "$name" "$preserve_file" >/dev/null 2>&1; then
          echo "preserve worktree: $name"
          continue
        fi
        modified="$(path_mtime "$directory")"
        if [ "$modified" -gt "$cutoff" ]; then
          echo "grace-period worktree: $name"
          continue
        fi
        printf '%s\n' "$directory" >>"$worktree_candidates"
      done
  worktree_count="$(wc -l <"$worktree_candidates" | tr -d ' ')"
  worktree_bytes="$(while IFS= read -r directory; do [ -n "$directory" ] && path_bytes "$directory"; done <"$worktree_candidates" | awk '{s+=$1} END {print s+0}')"
  echo "worktree candidates: $worktree_count ($worktree_bytes bytes)"
  if [ "$worktree_count" -gt 0 ]; then
    echo "worktree candidate names:"
    sed 's#.*/##' "$worktree_candidates" | sed -n '1,40p'
    [ "$worktree_count" -le 40 ] || echo "... $((worktree_count - 40)) more"
  fi

  if [ "$APPLY" -eq 1 ]; then
    deleted=0
    while IFS= read -r directory; do
      [ -n "$directory" ] || continue
      [ "$(dirname "$directory")" = "$WORKTREE_ROOT" ] \
        || fail "unsafe worktree candidate: $directory"
      common=""
      if git -C "$directory" rev-parse --git-common-dir >/dev/null 2>&1; then
        common="$(git -C "$directory" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
      fi
      if [ -n "$common" ] && git --git-dir="$common" worktree remove --force "$directory" >/dev/null 2>&1; then
        :
      else
        rm -rf -- "$directory"
      fi
      [ ! -e "$directory" ] || fail "worktree removal failed: $directory"
      if [ -n "$common" ]; then
        git --git-dir="$common" worktree prune >/dev/null 2>&1 || true
      fi
      deleted="$((deleted + 1))"
    done <"$worktree_candidates"
    echo "worktrees deleted: $deleted"
  fi
fi

if [ "$SKIP_SNAPSHOTS" -eq 0 ]; then
  [ -d "$DATA_ROOT" ] || fail "data root missing: $DATA_ROOT"
  [ "$(realpath "$DATA_ROOT")" = "$DATA_ROOT" ] \
    || fail "data root is not canonical: $DATA_ROOT"
  find "$DATA_ROOT" -type f \( -name '*.db' -o -name 'autopod.db.before-*' \) \
    ! -path "$DATA_ROOT/autopod.db" -print \
    | while IFS= read -r snapshot; do printf '%s|%s\n' "$(path_mtime "$snapshot")" "$snapshot"; done \
    | sort -nr >"$snapshot_order"
  awk -F'|' -v keep="$SNAPSHOT_RETAIN" 'NR > keep { sub(/^[^|]*\|/, ""); print }' \
    "$snapshot_order" >"$snapshot_candidates"
  snapshot_count="$(wc -l <"$snapshot_candidates" | tr -d ' ')"
  snapshot_bytes="$(while IFS= read -r snapshot; do [ -n "$snapshot" ] && path_bytes "$snapshot"; done <"$snapshot_candidates" | awk '{s+=$1} END {print s+0}')"
  echo "snapshot candidates: $snapshot_count ($snapshot_bytes bytes); retain newest $SNAPSHOT_RETAIN"
  if [ "$APPLY" -eq 1 ]; then
    deleted=0
    while IFS= read -r snapshot; do
      [ -n "$snapshot" ] || continue
      case "$snapshot" in "$DATA_ROOT"/*) ;; *) fail "unsafe snapshot candidate: $snapshot";; esac
      rm -f -- "$snapshot"
      [ ! -e "$snapshot" ] || fail "snapshot removal failed: $snapshot"
      deleted="$((deleted + 1))"
    done <"$snapshot_candidates"
    echo "snapshots deleted: $deleted"
  fi
fi

if [ "$SKIP_JOURNALS" -eq 0 ]; then
  echo "journal usage before: $(journalctl --disk-usage)"
  if [ "$APPLY" -eq 1 ]; then
    journalctl --vacuum-size="$JOURNAL_SIZE"
    echo "journal usage after: $(journalctl --disk-usage)"
  fi
fi

echo "=== disk after ==="
df -h /
echo "service: $(systemctl is-active "$SERVICE")"
echo "CLEANUP_COMPLETE mode=$([ "$APPLY" -eq 1 ] && echo apply || echo dry-run)"
