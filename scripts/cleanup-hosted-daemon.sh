#!/usr/bin/env bash
#
# cleanup-hosted-daemon.sh — guarded disk cleanup for the hosted Autopod VM.
#
# Dry-run is the default. Applying cleanup requires --apply and confirmation
# (or --yes). Active pod worktrees are discovered from the daemon API while an
# admission drain prevents new work from racing the cleanup. Releases are never
# removed by this script.
#
# Usage:
#   scripts/cleanup-hosted-daemon.sh
#   scripts/cleanup-hosted-daemon.sh --apply
#   scripts/cleanup-hosted-daemon.sh --apply --yes \
#     --preserve-worktree tender-mink \
#     --preserve-worktree anxious-takin
#
# Options:
#   --apply                       Perform cleanup (default: dry-run)
#   --yes, -y                     Skip the apply confirmation
#   --preserve-worktree <pod-id>  Preserve a terminal pod worktree (repeatable)
#   --snapshot-retain <n>         Keep the newest n snapshots (default: 1)
#   --journal-size <size>         systemd journal target (default: 200M)
#   --min-age-minutes <n>         Worktree deletion grace period (default: 60)
#   --skip-docker                 Do not prune dangling Docker images
#   --skip-worktrees              Do not inspect or remove worktrees
#   --skip-snapshots              Do not inspect or remove DB snapshots
#   --skip-journals               Do not inspect or vacuum system journals
#
set -euo pipefail

RG="${AUTOPOD_CLEANUP_RESOURCE_GROUP:-ewi-sandboxes}"
VM="${AUTOPOD_CLEANUP_VM:-autopod-daemon}"
WORKTREE_ROOT="${AUTOPOD_CLEANUP_WORKTREE_ROOT:-/home/ewi/.autopod/worktrees}"
DATA_ROOT="${AUTOPOD_CLEANUP_DATA_ROOT:-/data/autopod}"
CURRENT_LINK="${AUTOPOD_CLEANUP_CURRENT_LINK:-/opt/autopod/current}"
SERVICE="${AUTOPOD_CLEANUP_SERVICE:-autopod-daemon}"
HEALTH_URL="${AUTOPOD_CLEANUP_HEALTH_URL:-https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/health}"

NONTERMINAL_STATUSES="queued,provisioning,running,awaiting_input,paused,validating,validated,review_required,approved,merging,merge_pending,killing"
APPLY=0
ASSUME_YES=0
SNAPSHOT_RETAIN=1
JOURNAL_SIZE="200M"
MIN_AGE_MINUTES=60
SKIP_DOCKER=0
SKIP_WORKTREES=0
SKIP_SNAPSHOTS=0
SKIP_JOURNALS=0
PRESERVE_NAMES=""
DEPLOY_DRAIN_ACTIVE=0
TOKEN=""
DAEMON=""

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "==> $*"; }

append_preserve() {
  local name="$1"
  if [ -z "$PRESERVE_NAMES" ]; then
    PRESERVE_NAMES="$name"
  else
    PRESERVE_NAMES="$PRESERVE_NAMES"$'\n'"$name"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    --preserve-worktree)
      [ "$#" -ge 2 ] || die "--preserve-worktree requires a pod ID"
      case "$2" in *[!A-Za-z0-9._-]*|'') die "invalid pod ID for --preserve-worktree: $2";; esac
      append_preserve "$2"
      shift 2
      ;;
    --snapshot-retain)
      [ "$#" -ge 2 ] || die "--snapshot-retain requires a value"
      SNAPSHOT_RETAIN="$2"; shift 2;;
    --journal-size)
      [ "$#" -ge 2 ] || die "--journal-size requires a value"
      JOURNAL_SIZE="$2"; shift 2;;
    --min-age-minutes)
      [ "$#" -ge 2 ] || die "--min-age-minutes requires a value"
      MIN_AGE_MINUTES="$2"; shift 2;;
    --skip-docker) SKIP_DOCKER=1; shift;;
    --skip-worktrees) SKIP_WORKTREES=1; shift;;
    --skip-snapshots) SKIP_SNAPSHOTS=1; shift;;
    --skip-journals) SKIP_JOURNALS=1; shift;;
    -h|--help) sed -n '2,31p' "$0"; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

case "$SNAPSHOT_RETAIN" in *[!0-9]*|'') die "--snapshot-retain must be a positive integer";; esac
[ "$SNAPSHOT_RETAIN" -ge 1 ] || die "--snapshot-retain must be at least 1"
case "$MIN_AGE_MINUTES" in *[!0-9]*|'') die "--min-age-minutes must be a non-negative integer";; esac
if [[ ! "$JOURNAL_SIZE" =~ ^[0-9]+[KMG]$ ]]; then
  die "--journal-size must look like 200M or 1G"
fi

for value in "$RG" "$VM" "$WORKTREE_ROOT" "$DATA_ROOT" "$CURRENT_LINK" "$SERVICE"; do
  case "$value" in *[!A-Za-z0-9_./:-]*|'') die "unsafe cleanup configuration value: $value";; esac
done

command -v az >/dev/null || die "az CLI not found"
az account show >/dev/null 2>&1 || die "az not logged in — run: az login"

remote() {
  az vm run-command invoke -g "$RG" -n "$VM" --command-id RunShellScript \
    --scripts "$1" --query "value[0].message" -o tsv 2>&1
}

release_hosted_deploy_drain() {
  if [ "$DEPLOY_DRAIN_ACTIVE" -eq 1 ]; then
    curl -sS --max-time 10 -X DELETE "$DAEMON/maintenance/hosted-deploy-drain" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    DEPLOY_DRAIN_ACTIVE=0
  fi
}

load_active_worktree_names() {
  local response
  response="$(curl -sS --max-time 15 \
    "$DAEMON/pods?status=$NONTERMINAL_STATUSES&compact=true&limit=500" \
    -H "Authorization: Bearer $TOKEN")" || die "could not query nonterminal pods"
  printf '%s' "$response" | WORKTREE_ROOT="$WORKTREE_ROOT" python3 -c '
import json, os, sys
try:
    payload = json.load(sys.stdin)
except Exception as exc:
    raise SystemExit(f"invalid pod response: {exc}")
pods = payload if isinstance(payload, list) else payload.get("pods", payload.get("items", []))
if not isinstance(pods, list):
    raise SystemExit("pod response did not contain a list")
if len(pods) >= 500:
    raise SystemExit("nonterminal pod query reached its 500-record safety limit")
root = os.path.normpath(os.environ["WORKTREE_ROOT"])
for pod in pods:
    if not isinstance(pod, dict):
        continue
    path = pod.get("worktreePath")
    if not path:
        continue
    normalized = os.path.normpath(path)
    if os.path.dirname(normalized) != root:
        raise SystemExit(f"unsafe active worktree path: {path}")
    print(os.path.basename(normalized))
'
}

if [ "$SKIP_WORKTREES" -eq 0 ]; then
  command -v ap >/dev/null || die "ap CLI not found — use --skip-worktrees for non-worktree cleanup"
  command -v python3 >/dev/null || die "python3 not found — required for active-worktree safety"
  TOKEN="$(ap token 2>/dev/null || true)"
  DAEMON="${AUTOPOD_CLEANUP_DAEMON:-$(grep -E '^daemon:' "$HOME/.autopod/config.yaml" 2>/dev/null | awk '{print $2}')}"
  [ -n "$TOKEN" ] || die "could not mint daemon token — refusing worktree cleanup"
  [ -n "$DAEMON" ] || die "daemon URL not configured — refusing worktree cleanup"

  ACTIVE_NAMES="$(load_active_worktree_names)"
  while IFS= read -r name; do
    [ -n "$name" ] && append_preserve "$name"
  done <<<"$ACTIVE_NAMES"
fi

PRESERVE_NAMES="$(printf '%s\n' "$PRESERVE_NAMES" | sed '/^$/d' | sort -u)"

echo
echo "  HOSTED CLEANUP PLAN"
echo "  VM:                $RG/$VM"
echo "  mode:              $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)"
echo "  worktree grace:    ${MIN_AGE_MINUTES}m"
echo "  snapshot retain:   $SNAPSHOT_RETAIN"
echo "  journal target:    $JOURNAL_SIZE"
echo "  docker:            $([ "$SKIP_DOCKER" -eq 1 ] && echo SKIPPED || echo 'dangling only')"
echo "  worktrees:         $([ "$SKIP_WORKTREES" -eq 1 ] && echo SKIPPED || echo 'terminal/orphaned only')"
echo "  snapshots:         $([ "$SKIP_SNAPSHOTS" -eq 1 ] && echo SKIPPED || echo enabled)"
echo "  journals:          $([ "$SKIP_JOURNALS" -eq 1 ] && echo SKIPPED || echo enabled)"
echo "  releases:          NEVER TOUCHED"
if [ -n "$PRESERVE_NAMES" ]; then
  echo "  preserved pods:"
  while IFS= read -r name; do echo "    - $name"; done <<<"$PRESERVE_NAMES"
else
  echo "  preserved pods:    none with worktrees"
fi
echo

if [ "$APPLY" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ]; then
  printf "Apply this cleanup? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) die "aborted";; esac
fi

if [ "$APPLY" -eq 1 ] && [ "$SKIP_WORKTREES" -eq 0 ]; then
  note "activating hosted admission drain for worktree cleanup"
  drain_response="$(curl -sS --max-time 10 -X POST \
    "$DAEMON/maintenance/hosted-deploy-drain" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    --data '{"ttlSeconds":1800}')" || die "could not activate hosted admission drain"
  printf '%s' "$drain_response" | grep -q '"expiresAt"' \
    || die "hosted admission drain was not accepted"
  DEPLOY_DRAIN_ACTIVE=1
  trap release_hosted_deploy_drain EXIT

  # Re-resolve after admission closes so a pod that became active while the
  # operator reviewed the plan is protected too.
  ACTIVE_NAMES="$(load_active_worktree_names)"
  while IFS= read -r name; do
    [ -n "$name" ] && append_preserve "$name"
  done <<<"$ACTIVE_NAMES"
  PRESERVE_NAMES="$(printf '%s\n' "$PRESERVE_NAMES" | sed '/^$/d' | sort -u)"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_HELPER="$SCRIPT_DIR/cleanup-hosted-daemon-remote.sh"
[ -f "$REMOTE_HELPER" ] || die "missing remote cleanup helper: $REMOTE_HELPER"
REMOTE_HELPER_B64="$(base64 <"$REMOTE_HELPER" | tr -d '\n')"
PRESERVE_B64="$(printf '%s\n' "$PRESERVE_NAMES" | base64 | tr -d '\n')"

note "$([ "$APPLY" -eq 1 ] && echo applying || echo inspecting) hosted VM cleanup"
if ! out="$(remote "
set -eu
tmp=\$(mktemp /tmp/autopod-cleanup.XXXXXX)
trap 'rm -f \"\$tmp\"' EXIT
if ! printf '%s' '$REMOTE_HELPER_B64' | base64 -d >\"\$tmp\" 2>/dev/null; then
  printf '%s' '$REMOTE_HELPER_B64' | base64 -D >\"\$tmp\"
fi
chmod 700 \"\$tmp\"
APPLY='$APPLY' \\
WORKTREE_ROOT='$WORKTREE_ROOT' \\
DATA_ROOT='$DATA_ROOT' \\
CURRENT_LINK='$CURRENT_LINK' \\
SERVICE='$SERVICE' \\
SNAPSHOT_RETAIN='$SNAPSHOT_RETAIN' \\
JOURNAL_SIZE='$JOURNAL_SIZE' \\
MIN_AGE_MINUTES='$MIN_AGE_MINUTES' \\
SKIP_DOCKER='$SKIP_DOCKER' \\
SKIP_WORKTREES='$SKIP_WORKTREES' \\
SKIP_SNAPSHOTS='$SKIP_SNAPSHOTS' \\
SKIP_JOURNALS='$SKIP_JOURNALS' \\
PRESERVE_NAMES_B64='$PRESERVE_B64' \\
\"\$tmp\"
")"; then
  echo "$out" >&2
  die "remote cleanup command failed"
fi
echo "$out"
echo "$out" | grep -q 'CLEANUP_COMPLETE' || die "remote cleanup did not complete"

curl -sS --max-time 15 "$HEALTH_URL" >/dev/null \
  || die "external daemon health failed after cleanup"
note "external HTTPS health OK"

release_hosted_deploy_drain
trap - EXIT

if [ "$APPLY" -eq 0 ]; then
  note "dry-run complete — rerun with --apply after reviewing the plan"
else
  note "hosted VM cleanup complete"
fi
