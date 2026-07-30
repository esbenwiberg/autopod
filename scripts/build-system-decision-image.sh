#!/usr/bin/env bash
set -euo pipefail

image_ref="${SYSTEM_DECISION_IMAGE:-autopod-system-decision:local}"
dockerfile="templates/system/Dockerfile.decision"

if [[ "${1:-}" == "--check" ]]; then
  grep -q '^FROM node:22.18.0-slim$' "$dockerfile"
  grep -q '@anthropic-ai/claude-code@${CLAUDE_VERSION}' "$dockerfile"
  grep -q '@openai/codex@${CODEX_VERSION}' "$dockerfile"
  grep -q '@github/copilot@${COPILOT_VERSION}' "$dockerfile"
  grep -q '@earendil-works/pi-coding-agent@${PI_VERSION}' "$dockerfile"
  grep -q 'haproxy iptables' "$dockerfile"
  if grep -Eq 'COPY .*workspace|COPY .*packages|git clone' "$dockerfile"; then
    echo "system decision image must remain repo-free" >&2
    exit 1
  fi
  exit 0
fi

if [[ "${PUSH_SYSTEM_DECISION_IMAGE:-0}" == "1" ]]; then
  if [[ ! "$image_ref" =~ ^[a-zA-Z0-9-]+\.azurecr\.io/.+(:[^/]+|@sha256:[a-fA-F0-9]{64})$ ]] \
    || [[ "$image_ref" == *":latest" ]]; then
    echo "hosted image must use an ACR-qualified pinned tag or digest" >&2
    exit 1
  fi
  docker buildx build --file "$dockerfile" --tag "$image_ref" --push .
else
  docker build --file "$dockerfile" --tag "$image_ref" .
fi
