#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

tests=(
  src/pods/pod-lifecycle-runway.test.ts
  src/pods/pod-lifecycle-delivery-incidents.test.ts
  src/pods/state-machine.test.ts
  src/pods/agent-process-workflow.test.ts
  src/pods/validation-execution.test.ts
  src/pods/validation-infrastructure.test.ts
  src/pods/pod-lifecycle.e2e.test.ts
)
report=$(mktemp)
trap 'rm -f "$report"' EXIT
SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run "${tests[@]}" --maxWorkers=1 --passWithNoTests=false --reporter=default --reporter=json --outputFile.json="$report"
node - "$report" "${tests[@]}" <<'NODE'
const fs = require('node:fs');
const [report, ...expected] = process.argv.slice(2);
const results = JSON.parse(fs.readFileSync(report, 'utf8'));
for (const file of expected) {
  const suite = results.testResults.find((item) => item.name.endsWith(`/${file}`));
  if (!suite || !suite.assertionResults.length || suite.assertionResults.some((test) => test.status !== 'passed')) {
    throw new Error(`Lifecycle gate requires executed passing tests in ${file}`);
  }
}
NODE
