#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

dockerfile="$repo_root/templates/system/Dockerfile.decision"
grep -q 'mkdir -p /run/autopod /tmp/system-decision /home/autopod/.claude /home/autopod/.codex /home/autopod/.pi/agent' "$dockerfile"
grep -q 'chown -R autopod:autopod /run/autopod /tmp/system-decision /home/autopod/.claude /home/autopod/.codex /home/autopod/.pi' "$dockerfile"

mkdir -p "$tmp_dir/bin"
cat > "$tmp_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$DOCKER_ARGS_FILE"
EOF
chmod +x "$tmp_dir/bin/docker"

image_ref='ewiautopodacr.azurecr.io/autopod/system-decision:95fe98e6'
args_file="$tmp_dir/docker-args"
(
  cd "$repo_root"
  PATH="$tmp_dir/bin:$PATH" \
    DOCKER_ARGS_FILE="$args_file" \
    SYSTEM_DECISION_IMAGE="$image_ref" \
    PUSH_SYSTEM_DECISION_IMAGE=1 \
    ./scripts/build-system-decision-image.sh
)

cat > "$tmp_dir/expected-args" <<EOF
buildx
build
--platform
linux/amd64
--file
templates/system/Dockerfile.decision
--tag
$image_ref
--push
.
EOF

diff -u "$tmp_dir/expected-args" "$args_file"

if (
  cd "$repo_root"
  PATH="$tmp_dir/bin:$PATH" \
    DOCKER_ARGS_FILE="$args_file" \
    SYSTEM_DECISION_IMAGE='ewiautopodacr.azurecr.io/autopod/system-decision:latest' \
    PUSH_SYSTEM_DECISION_IMAGE=1 \
    ./scripts/build-system-decision-image.sh >/dev/null 2>&1
); then
  echo 'publication unexpectedly accepted a mutable latest tag' >&2
  exit 1
fi

echo 'system decision image publication contract OK'
