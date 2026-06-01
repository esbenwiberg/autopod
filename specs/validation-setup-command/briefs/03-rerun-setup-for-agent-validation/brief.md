---
title: "Rerun setup for agent self-validation"
touches:
  - packages/escalation-mcp/src/pod-bridge.ts
  - packages/escalation-mcp/src/server.ts
  - packages/escalation-mcp/src/tools/validate-locally.ts
  - packages/escalation-mcp/src/tools/validate-locally.test.ts
  - packages/escalation-mcp/src/server.test.ts
  - packages/daemon/src/pods/pod-bridge-impl.ts
  - packages/daemon/src/pods/pod-bridge-validation.test.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/desktop/
---

## Task
Expose setup through the MCP validation bridge and make `validate_locally`
prepend setup before requested validation phases on every call.

`validate_locally({ phases: ['lint'] })` should run setup first when configured
and not skipped, then run lint. Repeating the same call should run setup again.

## Touches
Update escalation MCP phase types/schema/tool implementation and daemon
pod-bridge execution for setup.

## Does not touch
Do not change the daemon full validation pipeline or desktop UI in this brief.

## Constraints
Setup failure skips requested downstream phases and returns `passed: false`.
Missing setup or profile-skipped setup is neutral. Use the same command working
directory, environment, and timeout conventions as other bridge validation
phases, with setup reusing `buildTimeout`.

## Test expectations
Cover default order, explicit phase lists, every-call rerun behavior, setup
failure skip behavior, profile-skipped setup, bridge command resolution, and MCP
schema acceptance.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run focused tests named in `contract.yaml`.
3. Commit and push.
