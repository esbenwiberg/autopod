# Profile configuration form audit

Reviewed 2026-10-18. Implementation: `6eb5addf42b390859e8782e6a87725c65a968d82`.
Freshly fetched main: `6e51d1ce9495235e6aac2e498393cd2dd9a0e66b`.

**Original audit verdict: FAILED for configuration form completeness.** The redesigned library
has all configuration kinds, but that does not establish field parity. The
previous source parity review missed controls that cannot create absent values,
empty dictionaries and collections. Keep PR #439 draft pending repairs and
interaction checks. The original audit was documentation-only; the follow-up below records subsequent repairs.

## First repair slice

The follow-up implements Profile's Network and Sidecars areas. Network can start
from absent/null policy and edit isolation, mode, host rows, package-manager and
default-host flags. Sidecars shows definitions from the selected Environment,
required instances, always/disabled states, allocations, unavailable saved IDs,
and an Environment sidecar-editor link through the existing discard guard.
Main CPU/storage limits and sidecar limits retain unsupported saved values for
explicit reset. Environment health timeout has a numeric field.

Native interaction tests exercise policy creation from absent/null, host editing,
save/reopen, preservation of unrelated policy/execution fields, sidecar selection
from an empty map, allocation save/reset/reopen, missing IDs, definition links and
unsupported limits. These are owned native views with in-memory actions; they do
not establish saving to a real daemon or launching a real sidecar.

Work and Evidence now use left section rails. Validation uses one horizontal
phase-card strip with icons/status and selected phase content below. Tests click
the real controls and check rail/card geometry at 680 and 1400 points in dark and
light appearance. The full Preview's detail navigation was also operated through
computer use. Native access then failed again at profile editing with `native
pipe closed before response`; profile evidence uses the owned native test views.

Validation for this slice: `./scripts/test-desktop.sh` passes 560 Swift Testing
tests (355 Client, 11 Desktop, 194 UI) and 13 XCTest tests. The eight new test
functions include parameterized empty/null and dark/light compact/wide cases.
`./scripts/build-desktop-preview.sh --fixtures` builds the separate signed
`com.autopod.desktop.preview` app. These results do not include a real daemon
profile save or real sidecar launch.

**Overall form completeness remains partial.** Workflow scan/budget/escalation,
repository validation/registries, value/credential maps and skill description
remain open. This slice does not close the whole gap matrix or connected acceptance.

## Evidence boundary

- Native computer use reached Preview's fleet and Profiles library. Preview
  explicitly identifies its records as sample data. The user's native screenshot
  shows the empty Sidecars group with no Add control.
- Inspected the final branch's actual editors, current shared schemas and legacy
  profile editor. Main was fetched explicitly before comparison.
- `ConfigurationCollectionEditors.swift` is identical to current main. Its
  incomplete generic execution editor was inherited, rather than removed by the
  visual redesign. This still leaves the replacement workflow incomplete.
- Native access to the installed current app failed with `native pipe closed
  before response`. The legacy comparison below is source evidence, not a claim
  of operating that app. No live profile, network policy or sidecar was changed.
- Existing passing layout tests check fitting dimensions; they do not assert that
  every schema field has a usable control or test adding entries from empty state.

## Confirmed gaps

“Complete JSON” below means the entire payload escape hatch. Preserving a value
in that payload is not the same as providing a usable form control.

| Owner / field | Current form behavior | Required repair |
| --- | --- | --- |
| Profile execution: `networkPolicy` | `ProfileExecutionDefaultsEditor` delegates to a generic existing-key editor. New profile payloads omit the key entirely; a saved null opens a JSON field. Existing object values still use generic text/JSON controls. | Dedicated network section for unset policy, isolation enabled, allow-all/deny-all/restricted, host add/remove, package-manager access and `replaceDefaults`. Keep backend semantics and saved values. |
| Profile: `requiredSidecarIds` | No form reads or writes it; the initial profile omits it. Launch-time selection exists separately and does not repair the saved profile editor. | Select the selected environment's on-demand sidecars as profile defaults; distinguish always-start and disabled definitions. Retain unavailable saved selections visibly. |
| Profile execution: `sidecars` allocations | An empty dictionary renders only a Sidecars heading. Generic recursion cannot add an instance ID or missing allocation fields. | Show allocation controls keyed by actual environment sidecar IDs, with memory/CPU/storage subject to backend capability. Support returning to defaults. |
| Profile execution: `main.storageGb` | Main container editor shows memory and local CPUs only. The fallback excludes the entire `main` object, so storage remains inaccessible in the form. | Provide storage where the backend supports it; explain unsupported saved values without silently dropping them. |
| Environment sidecar: `healthTimeoutMs` | The environment has a real Add/Remove sidecar editor for type, ID, digest image, version, startup and port. It never exposes the health timeout. | Add a health timeout with units and bounds. Link the profile's sidecar section to its environment so adding definitions is discoverable. |
| Workflow: `securityScan` | No form references this field. Complete JSON is the only editing route. The legacy profile editor has a dedicated scan editor. | Form controls for detector enablement and thresholds, provisioning/push checkpoint enablement/scope/outcomes, and always-scan paths. |
| Workflow: `tokenBudgetWarnAt` | Budget, policy, reviewer limit and extensions are shown; warning threshold is omitted. | Show the saved warning percentage and allow editing within schema bounds. |
| Workflow escalation: `askHuman`, `askAi.enabled` | Consultation count, advisor, pause count and timeout are shown, but the two enable switches are absent. Editing the count on a new document does not enable consultation. | Explicit human-escalation and AI-consultation switches; preserve null/default semantics. The consultation route/model belongs in AI settings. |
| Workflow escalation: `askAi.maxCalls`, `humanResponseTimeout` | Count control is capped at 20 although schema accepts 50. Timeout offers only 900/3600/7200/21600/86400 seconds although schema permits 60–86400. | Permit the full supported ranges and display valid existing custom values. |
| Repository setup: `sastCommand`, `prepareCommand`, `healthPath`, `healthTimeout`, `buildTimeout`, `testTimeout`, `lintTimeout`, `sastTimeout`, `hasWebUi` | Only setup/build/test/lint/start commands have dedicated controls. Advanced shows other scalar keys only if already present. New setups initially have just ID/name/defaultBranch. | Typed commands, health/web UI settings and timeouts with units, usable before first save. |
| Repository setup: `smokePages` and assertions | Advanced falls back to JSON for arrays, and only if present. Legacy profile UI supports adding smoke pages. | Add/remove pages and assertions with path/selector/type/value controls. |
| Repository setup: `buildEnv` | Generic object editor cannot add an environment variable to an empty dictionary or construct a value/secret reference. | Key/value and credential-reference rows, with add/remove and clear destination/context. |
| Repository setup integrations: `prProvider`, `privateRegistries` | Entire `integrations` object is excluded from Advanced. Services and Deployment edit only their own branches; provider and registry configuration have no form. | Provider picker plus registry add/remove with type, URL, scope, credential reference and expiry. |
| Deployment: `env` | “Environment and credential references” uses the same generic existing-key editor; an empty map cannot gain entries. | Reuse the value/reference map editor, without exposing secret values. |
| Tool-pack MCP HTTP `headers` / stdio `env` | Credential-reference disclosure delegates empty maps to the generic editor, with no Add control. | Reuse the value/reference map editor for both transports. |
| Tool-pack skill: `description` | Optional schema field is preserved in the payload but has no form control. | Optional description in the skill row. |

## Configurations that moved rather than disappeared

The ownership map is in `LEGACY_PROFILE_FIELD_OWNERS` in
`packages/daemon/src/configuration/legacy-profile-migration.ts` and the candidate
contract in `docs/composable-configuration.md`.

- Sidecar **definitions** and software belong to Environment. Profile selects
  required instances and their resource defaults. The empty group in the user
  screenshot is the allocation map, not the environment's Add-sidecar list.
- Build/test/start commands, health, smoke pages, registries and service access
  belong to a repository's Project setup.
- Validation, budgets, escalation and scan policy belong to Workflow.
- Accounts, models, independent review and failover belong to AI setup. Provider
  authentication belongs in Settings, not plaintext profile credentials.
- Skills, MCP, instructions and code-intelligence tools belong to Tool packs.
- Privileged sidecar trust belongs to repository trusted setups. PIM selections
  remain in Profile's Access & worker area. Issue watchers, deployments and
  memory have their own routes.
- Inheritance/merge strategies, old custom actions and test-repository pipelines
  are retired by the composable contract. They must not be reintroduced as if
  these were missing current-schema fields. Legacy PATs likewise do not belong
  in new forms; use the established credential/account model.

AI target/route fields and GitHub access scope/operation/workflow/branch fields
have dedicated controls in the inspected source. That is source coverage, not
proof that every connected interaction works.

## Source references

- `packages/shared/src/schemas/launch-config.schema.ts`: current payload schemas.
- `packages/shared/src/schemas/profile.schema.ts`: reused network, escalation and
  security scan schemas.
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ConfigurationLibraryView.swift`:
  profile/workflow/environment forms, new-document payloads, generic existing-key
  editor, setup selection and save payload.
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ConfigurationCollectionEditors.swift`:
  execution, repository setup, sidecar, skill and MCP editors.
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift`:
  legacy network, sidecar, validation, budget, credential and security-scan UI.
- `packages/desktop/Sources/AutopodUI/Views/Creation/LaunchConfigurationEditor.swift`:
  existing per-launch sidecar selection/allocation, distinct from saved defaults.

## Repair and acceptance order

1. Profile Execution: explicit Network and Sidecars sections, linked environment
   definitions, required sidecars, capability-aware allocations and main storage.
2. Workflow: scan policy, warning threshold and complete escalation controls.
3. Repository setup: full build/validation form, smoke assertions, registries and
   reusable value/credential-reference maps; reuse maps in Deployment and MCP.
4. Environment timeout and skill description.

For each repair, exercise new/empty, saved/populated and unavailable-reference
states. Verify save/reopen and unchanged unrelated payload fields. Use fictional
native fixtures for visual review before connected acceptance. A test that only
checks the host view's size cannot establish these behaviors.
