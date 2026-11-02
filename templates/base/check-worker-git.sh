#!/bin/sh
set -eu

# Prove the operation required by integration, not merely a version/help string.
# This fixture never reads or changes the application checkout or its remotes.
fixture=$(mktemp -d "${TMPDIR:-/tmp}/autopod-git-check.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
# Do not inherit Git selectors from a caller's checkout or index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS

git init -q --initial-branch=main --template= "$fixture"
git -C "$fixture" -c user.name=Fixture -c user.email=fixture@example.invalid \
  -c commit.gpgsign=false commit -q --allow-empty -m base
base=$(git -C "$fixture" rev-parse HEAD)
git -C "$fixture" -c user.name=Fixture -c user.email=fixture@example.invalid \
  -c commit.gpgsign=false commit -q --allow-empty -m tip
tip=$(git -C "$fixture" rev-parse HEAD)
if ! git -C "$fixture" merge-tree --write-tree --merge-base="$base" "$base" "$tip" >/dev/null; then
  echo 'Worker Git lacks the required merge-tree --merge-base operation.' >&2
  exit 1
fi
git --version
