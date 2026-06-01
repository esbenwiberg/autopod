#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/packages/desktop"

runtime_options="$DESKTOP/Sources/AutopodUI/Models/RuntimeModelOptions.swift"
profile_model="$DESKTOP/Sources/AutopodUI/Models/Profile.swift"
profile_response="$DESKTOP/Sources/AutopodClient/Types/ProfileResponse.swift"
profile_mapper="$DESKTOP/Sources/AutopodDesktop/Mapping/ProfileMapper.swift"
profile_editor="$DESKTOP/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift"
field_catalog="$DESKTOP/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift"

require_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -Fq "$pattern" "$file"; then
    echo "Expected $file to contain: $pattern" >&2
    exit 1
  fi
}

require_absent() {
  local file="$1"
  local pattern="$2"
  if grep -Fq "$pattern" "$file"; then
    echo "Expected $file not to contain: $pattern" >&2
    exit 1
  fi
}

require_contains "$runtime_options" 'public enum ClaudeModelCanonicalizer'
require_contains "$runtime_options" '"opus": "claude-opus-4-8"'
require_contains "$runtime_options" 'RuntimeModelOption(value: "claude-opus-4-8", label: "Opus 4.8")'
require_contains "$runtime_options" '"claude-opus-4-7": RuntimeModelPrice'
require_contains "$runtime_options" '"claude-opus-4-7": "Opus 4.7"'

require_contains "$profile_model" 'defaultModel: String = "claude-opus-4-8"'
require_contains "$profile_model" 'escalationAskAiModel: String = "claude-sonnet-4-6"'
require_contains "$profile_response" 'defaultModel = "claude-opus-4-8"'
require_contains "$profile_response" 'reviewerModel = "claude-sonnet-4-6"'
require_contains "$profile_response" 'model = "claude-sonnet-4-6"'
require_contains "$profile_mapper" 'ClaudeModelCanonicalizer.normalizedLegacyAlias(model)'
require_contains "$profile_mapper" 'reviewerModel: canonicalProfileModel(response.reviewerModel ?? "claude-sonnet-4-6")'

require_contains "$profile_editor" 'claude-opus-4-8'
require_contains "$profile_editor" 'ask_ai'
require_contains "$field_catalog" 'claude-opus-4-8'
require_contains "$field_catalog" 'ask_ai'

require_absent "$profile_editor" 'Text("Ask AI model")'
require_absent "$profile_editor" 'TextField("sonnet", text: $profile.escalationAskAiModel)'
require_absent "$profile_editor" 'fieldRow("Consultation Model"'
require_absent "$profile_editor" 'Text("Sonnet").tag("sonnet")'
require_absent "$profile_editor" 'Text("Opus").tag("opus")'
require_absent "$field_catalog" 'claude-opus-4-7`, `auto`'

echo "Desktop canonical model source contract passed."
