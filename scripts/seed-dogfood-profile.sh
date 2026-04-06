#!/usr/bin/env bash
# seed-dogfood-profile.sh — Create the autopod-self dog-fooding profile
set -euo pipefail

HOST="${AUTOPOD_HOST:-http://127.0.0.1:3100}"
TOKEN_FILE="$HOME/.autopod/dev-token"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "No dev token at $TOKEN_FILE — start the daemon first (./scripts/start-dev.sh)" >&2
  exit 1
fi

TOKEN=$(cat "$TOKEN_FILE")

BODY=$(cat <<'JSON'
{
  "name": "autopod-self",
  "repoUrl": "https://github.com/esbenwiberg/autopod",
  "defaultBranch": "main",
  "template": "node22-pw",
  "buildCommand": "npx pnpm install && npm_config_nodedir=/usr/local npx pnpm rebuild better-sqlite3 && npx pnpm build",
  "testCommand": "npx pnpm test",
  "startCommand": "NODE_ENV=development AUTOPOD_MOCK_DOCKER=true HOST=0.0.0.0 PORT=$PORT node packages/daemon/dist/index.js",
  "healthPath": "/health",
  "healthTimeout": 120,
  "smokePages": [{ "path": "/health" }],
  "maxValidationAttempts": 3,
  "defaultModel": "sonnet",
  "defaultRuntime": "claude",
  "networkPolicy": {
    "enabled": true,
    "mode": "restricted"
  },
  "escalation": {
    "askHuman": true,
    "askAi": { "enabled": true, "model": "opus", "maxCalls": 5 },
    "autoPauseAfter": 10,
    "humanResponseTimeout": 7200
  },
  "outputMode": "pr",
  "buildTimeout": 600,
  "testTimeout": 600,
  "customInstructions": "- The build command handles native addon compilation (better-sqlite3) automatically. If you see native binding errors AFTER the build command has already run, this is an infrastructure problem you CANNOT fix. Call `report_blocker` immediately. Do NOT run node-gyp, install headers, modify .npmrc, or change any build configuration.\n- Do not try to read ~/.autopod/dev-token or authenticate with the daemon API. You have no access to the host daemon. All external communication goes through MCP tool calls.\n- The daemon runs on port 3100 on the HOST — you cannot access it from inside this container via localhost:3100.\n- Do not retry identical failing commands more than twice. Diagnose the root cause or try a different approach."
}
JSON
)

RESPONSE=$(curl -sf -w "\n%{http_code}" \
  -X POST "$HOST/profiles" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$BODY" 2>&1) || {
  CODE=$(echo "$RESPONSE" | tail -1)
  BODY_OUT=$(echo "$RESPONSE" | sed '$d')
  if echo "$BODY_OUT" | grep -q "already exists"; then
    echo "Profile 'autopod-self' already exists. Use 'ap profile edit autopod-self' to update."
    exit 0
  fi
  echo "Failed to create profile (HTTP $CODE):" >&2
  echo "$BODY_OUT" >&2
  exit 1
}

echo "Profile 'autopod-self' created."
echo ""
echo "Verify: curl -s $HOST/profiles/autopod-self | jq ."
echo ""
echo "Run a scenario:"
echo "  ap run autopod-self \"<task description>\""
