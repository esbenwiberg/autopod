# alright-landfowl Handover

## Built

- Added `setup` to the escalation MCP `ValidationPhaseName` bridge contract.
- Updated the `validate_locally` tool schema to accept `setup`.
- Changed `validate_locally` default order to `setup`, `lint`, `build`, `tests`.
- Made explicit downstream requests prepend setup on every call, including repeated calls.
- Made setup failure return `passed: false` and mark requested downstream phases skipped without executing them.
- Wired daemon `runValidationPhase('setup')` to `profile.validationSetupCommand`.
- Reused build timeout, validation cwd, and validation env handling for setup.
- Treated missing setup and profile-skipped setup as unconfigured neutral phases.
- Added focused MCP and daemon bridge tests for setup ordering, reruns, failure skips, schema acceptance, command resolution, and profile-skipped setup.

## Deviations

- The brief says commit and push, but the pod operating environment says not to run `git push`; changes are committed locally and the host system is expected to push.
- The requested `/simplify` pass was performed through an MCP `ask_ai` simplification review plus local diff review because there is no native `/simplify` tool exposed in this container. Its useful ordering concern was addressed by normalizing explicit setup requests to setup-first and adding a regression test.

## Changed Interfaces

- `packages/escalation-mcp/src/pod-bridge.ts`
  - `ValidationPhaseName = 'setup' | 'lint' | 'build' | 'tests'`
- `validate_locally` MCP schema now accepts `phases: ['setup']`.
- `validate_locally({ phases: ['lint'] })` executes `setup` first, then `lint`.
- `validate_locally({ phases: ['lint', 'setup'] })` still executes setup first.
- `PodBridge.runValidationPhase(podId, 'setup')` resolves `validationSetupCommand`, unless `skipValidationPhases` includes `setup`.

## Owned Files

The next pod should not modify these without a specific reason:

- `packages/escalation-mcp/src/pod-bridge.ts`
- `packages/escalation-mcp/src/server.ts`
- `packages/escalation-mcp/src/tools/validate-locally.ts`
- `packages/escalation-mcp/src/tools/validate-locally.test.ts`
- `packages/escalation-mcp/src/server.test.ts`
- `packages/daemon/src/pods/pod-bridge-impl.ts`
- `packages/daemon/src/pods/pod-bridge-validation.test.ts`

## Constraints And Landmines

- The daemon full validation pipeline was intentionally not changed in this brief.
- Desktop was intentionally not changed in this brief.
- Setup is not cached in MCP self-validation; every `validate_locally` invocation calls `runValidationPhase('setup')` when setup is requested or prepended.
- A missing setup command and profile-skipped setup both return `configured: false` at the bridge boundary so downstream requested phases continue normally.
- `skipValidationPhases` uses the shared daemon phase spelling `setup`; the MCP bridge uses `tests` for the test phase.
