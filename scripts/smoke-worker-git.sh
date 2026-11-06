#!/usr/bin/env bash
# Check already-built coding images offline; never publish, pull, mount host data or wake a pod.
set -euo pipefail
if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <local-image-ref> [local-image-ref ...]" >&2
  exit 2
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_git=$(awk -F= '$1 == "version" { print $2 }' "$repo_root/templates/base/install-worker-git.sh")
if ! [[ "$expected_git" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Invalid pinned Git version in installer.' >&2
  exit 1
fi
for image in "$@"; do
  # Resolve once, then inspect/run that immutable local identity, not a moving tag.
  image_id=$(docker image inspect "$image" --format '{{.Id}}')
  if ! [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "Invalid immutable image identity for $image" >&2
    exit 1
  fi
  docker image inspect "$image_id" --format '{{.Id}} {{.Os}}/{{.Architecture}}'
  docker run --rm --pull=never --network none --entrypoint sh \
    -e EXPECTED_GIT_VERSION="$expected_git" "$image_id" -ec '
      test "$(id -u)" -ne 0
      test "$(command -v git)" = /usr/local/bin/git
      test "$(git --version)" = "git version $EXPECTED_GIT_VERSION"
      autopod-check-git
      test -x "$(git --exec-path)/git-remote-http"
      test -x "$(git --exec-path)/git-remote-https"
      test "$(git config --system --get maintenance.auto)" = false
      test "$(git config --system --get gc.auto)" = 0
    '
done
