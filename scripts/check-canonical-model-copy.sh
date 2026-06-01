#!/usr/bin/env bash
set -euo pipefail

files=(
  "README.md"
  "website/index.html"
  "packages/cli/src/commands/profile.ts"
)

require_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -Fq -- "$pattern" "$file"; then
    echo "Expected '$pattern' in $file" >&2
    exit 1
  fi
}

require_absent() {
  local file="$1"
  local pattern="$2"
  if grep -Fq -- "$pattern" "$file"; then
    echo "Unexpected '$pattern' in $file" >&2
    exit 1
  fi
}

require_absent_regex() {
  local file="$1"
  local pattern="$2"
  if grep -Eq -- "$pattern" "$file"; then
    echo "Unexpected regex '$pattern' in $file" >&2
    exit 1
  fi
}

for file in "${files[@]}"; do
  require_absent_regex "$file" "--model[ =]+['\"]?(opus|haiku)\\b"
  require_absent_regex "$file" "\\bmodel:[[:space:]]*['\"]?opus\\b"
  require_absent_regex "$file" "\\bmodel:[[:space:]]*['\"]?sonnet\\b"
  require_absent_regex "$file" "\\bmodel:[[:space:]]*['\"]?haiku\\b"
  require_absent_regex "$file" "\"model\"[[:space:]]*:[[:space:]]*\"(opus|sonnet|haiku)\""
  require_absent "$file" "escalation.askAi.model\` does double duty"
  require_absent "$file" "escalation.askAi.model</code></td>"
  require_absent "$file" "AI reviewer model in validation"
done

require_contains "README.md" "--model claude-opus-4-8"
require_contains "README.md" "ask_ai\` and the AI task review use \`profile.reviewerModel\`"
require_contains "website/index.html" "--model claude-opus-4-8"
require_contains "website/index.html" "<code>profile.reviewerModel</code>"
require_contains "packages/cli/src/commands/profile.ts" "defaultModel: 'claude-opus-4-8'"
require_contains "packages/cli/src/commands/profile.ts" "reviewerModel: 'claude-sonnet-4-6'"
