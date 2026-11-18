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
require_absent "$runtime_options" 'RuntimeModelOption(value: "claude-opus-4-8", label: "Opus 4.8")'
require_contains "$runtime_options" '"claude-opus-4-7": RuntimeModelPrice'
require_contains "$runtime_options" '"claude-opus-4-7": "Opus 4.7"'

require_contains "$profile_model" 'defaultModel: String = "claude-opus-5-5"'
require_contains "$profile_model" 'reviewerModel: String = "claude-sonnet-5-5"'
require_contains "$profile_model" 'escalationAskAiModel: String = "claude-sonnet-5-5"'
require_contains "$profile_response" 'defaultModel = "claude-opus-5-5"'
require_contains "$profile_response" 'reviewerModel = "claude-sonnet-5-5"'
require_contains "$profile_response" 'model = "claude-sonnet-5-5"'
require_contains "$profile_mapper" 'ClaudeModelCanonicalizer.normalizedLegacyAlias(model)'
require_contains "$profile_mapper" 'defaultModel: canonicalProfileModel(response.defaultModel ?? "claude-opus-5-5")'
require_contains "$profile_mapper" 'reviewerModel: canonicalProfileModel(response.reviewerModel ?? "claude-sonnet-5-5")'

require_contains "$profile_editor" 'claude-opus-5-5'
require_contains "$profile_editor" 'ask_ai'
require_contains "$field_catalog" 'claude-opus-5-5'
require_contains "$field_catalog" 'ask_ai'

require_absent "$profile_editor" 'Text("Ask AI model")'
require_absent "$profile_editor" 'TextField("sonnet", text: $profile.escalationAskAiModel)'
require_absent "$profile_editor" 'fieldRow("Consultation Model"'
require_absent "$profile_editor" 'Text("Sonnet").tag("sonnet")'
require_absent "$profile_editor" 'Text("Opus").tag("opus")'
require_absent "$field_catalog" 'claude-opus-4-7`, `auto`'

# Portable static checks only: this does not compile or execute Swift behavior.
node - "$ROOT" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = process.argv[2];
const read = path => fs.readFileSync(`${root}/${path}`, 'utf8');
const swift = read('packages/desktop/Sources/AutopodUI/Models/RuntimeModelOptions.swift');
const base = swift.split('private static func baseOptions(')[1].split('private static func isClaudeModel')[0];
const options = [...base.matchAll(/RuntimeModelOption\(value: "([^"]+)", label: "([^"]+)"\)/g)]
  .map(match => [match[1], match[2]]);
const opus = ['claude-opus-5-5', 'Opus 5.5'];
const sonnet = ['claude-sonnet-5-5', 'Sonnet 5.5'];
const fable = ['claude-fable-5-2', 'Fable 5.2'];
const haiku = ['claude-haiku-5-5', 'Haiku 5.5'];
assert.deepEqual(options, [opus, sonnet, fable, haiku, sonnet, opus, fable, haiku,
  ['auto', 'Auto'], ['gpt-6.2-sol', 'GPT-6.2 Sol'], ['gpt-6.2-astra', 'GPT-6.2 Astra'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra'], ['gpt-6-luna', 'GPT-6 Luna'],
  ['auto', 'Auto'], ['auto', 'Auto']], 'exact curated sets and role ordering');
assert.equal((base.match(/RuntimeModelOption\(/g) || []).length, options.length,
  'all base options must be checked, including multiline entries');
const prices = JSON.parse(read('packages/shared/src/pricing/model-pricing.json'));
for (const id of new Set(options.map(([id]) => id).filter(id => id !== 'auto'))) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = swift.match(new RegExp(`"${escaped}": RuntimeModelPrice\\(\\s*inputPer1M: ([\\d.]+),\\s*cachedInputPer1M: ([\\d.]+),\\s*outputPer1M: ([\\d.]+)\\s*\\)`));
  assert.ok(match, `desktop price for ${id}`);
  assert.deepEqual(match.slice(1).map(Number),
    [prices[id].inputPer1M, prices[id].cachedInputPer1M, prices[id].outputPer1M], id);
}
assert.ok(swift.includes('From \\(price.summary) (prompts ≤100k tokens; above 100k:'), 'Haiku tier caveat');
assert.ok(swift.includes('provider.policy.runnable, provider.policy.authorization == "supported"'));
assert.ok(swift.includes('$0.lifecycle == "active"'));
assert.ok(swift.includes('provider.modelIds.contains($0.id)'));
assert.ok(swift.includes('modelLabels[model] != nil || modelPricing[model] != nil'));
assert.ok(swift.includes('return isKnown ? "\\(label) (Legacy)" : label'));
for (const [path, call] of [
  ['packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift', 'RuntimeModelOptions.options('],
  ['packages/desktop/Sources/AutopodUI/Views/Profiles/ProviderFailoverEditor.swift', 'RuntimeModelOptions.options('],
  ['packages/desktop/Sources/AutopodDesktop/Stores/PodsitterStore.swift', 'RuntimeModelOptions.defaultOptions('],
]) assert.ok(read(path).includes(call), `${path} uses central options`);
NODE

echo "Desktop canonical model source contract passed (static only; native Swift tests require Mac/CI)."
