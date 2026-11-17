#!/usr/bin/env bash
# Fixed-budget PR coverage. The unfiltered "pnpm test" remains the full suite.
set -euo pipefail
cd "$(dirname "$0")/.."

# Explicit inventory: do not replace with "related"/affected-package expansion.
tests=(
  src/pods/state-machine.test.ts
  src/pods/pod-lifecycle-runway.test.ts
  src/pods/agent-process-workflow.test.ts
  src/pods/validation-execution.test.ts
  src/pods/validation-infrastructure.test.ts
  src/pods/pod-lifecycle.e2e.test.ts
  src/db/migrate.test.ts
  src/api/plugins/auth.test.ts
  src/crypto/pod-tokens.test.ts
  src/crypto/credentials-cipher.test.ts
)
for file in "${tests[@]}"; do
  test -f "packages/daemon/$file" || { echo "Missing PR smoke file: $file" >&2; exit 1; }
done

# Keep package scheduling and daemon file concurrency at their qualified limits.
npx pnpm exec turbo run test --filter='!@autopod/daemon' --concurrency=1

report=$(mktemp)
trap 'rm -f "$report"' EXIT
# Never silently downgrade the gate when SQLite bindings are unavailable.
SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run "${tests[@]}" \
  --maxWorkers=1 --passWithNoTests=false --reporter=default --reporter=json --outputFile.json="$report"
node scripts/check-pr-test-report.mjs "$report" "${tests[@]}"

node --test scripts/*.test.mjs packages/desktop/Tests/VillageHost/*.test.mjs
bash scripts/deploy-hosted-daemon.test.sh
bash scripts/cleanup-hosted-daemon.test.sh
npx pnpm village:check
