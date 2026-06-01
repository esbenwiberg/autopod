---
title: "Make validate_in_browser script generation subscription-safe"
touches:
  - packages/escalation-mcp/src/pod-bridge.ts
  - packages/escalation-mcp/src/tools/validate-in-browser.ts
  - packages/escalation-mcp/src/tools/validate-in-browser.test.ts
  - packages/escalation-mcp/src/server.test.ts
  - packages/escalation-mcp/src/tools/escalation-tools.test.ts
  - packages/daemon/src/pods/pod-bridge-impl.ts
  - packages/daemon/src/pods/pod-bridge-validation.test.ts
  - packages/daemon/src/validation/advisory-browser-qa-runner.ts
  - packages/daemon/src/validation/advisory-browser-qa-runner.test.ts
  - packages/daemon/src/validation/container-reviewer-runner.ts
  - packages/daemon/src/validation/container-reviewer-runner.test.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/integration.test.ts
  - packages/daemon/src/routes-extended.test.ts
does_not_touch:
  - packages/escalation-mcp/src/tools/ask-ai.ts
  - packages/escalation-mcp/src/tools/ask-human.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/host-browser-runner.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/providers/llm-client.ts
  - packages/daemon/src/providers/env-builder.ts
---

## Task
Make `validate_in_browser` generate its Playwright script through a dedicated
browser-script bridge method that uses the live pod container reviewer path.
The tool must no longer use generic `callReviewerModel` for script generation,
and it must fail clearly when no supported live container reviewer path is
available.

## Why
During the QA Advisory spike, `mcp__escalation__validate_in_browser` failed for
Max/Pro-style profiles because script generation fell through to daemon-side
direct Anthropic SDK calls. That bypasses the pod/container CLI auth path that
works for subscription accounts and also exposed the SDK request-shape timeout
bug. Browser self-validation should not require daemon-side API billing
credentials.

## Touches
This brief primarily touches the `PodBridge` interface, the
`validate_in_browser` tool, the daemon bridge implementation, and the tests
that prove the new routing. Extract the existing advisory browser QA container
reviewer code into `packages/daemon/src/validation/container-reviewer-runner.ts`
so advisory QA and `validate_in_browser` share the same CLI-backed reviewer
path. Update typed `PodBridge` test stubs only where the new interface method
requires it.

## Does not touch
Do not change `ask_ai` or `ask_human`; they may continue using
`callReviewerModel` in this brief. Do not rewrite host browser execution, the
host-to-container fallback behavior, screenshot storage, required-facts contract
behavior, provider env building, or pod-manager resume/validation orchestration.

## Constraints
Current script generation is the unsafe edge:
`const rawScript = await bridge.callReviewerModel(podId, prompt);`

Use the same kind of container-backed reviewer path already used by advisory
browser QA. The existing Codex helper documents the desired auth property:
"Runs the Codex CLI inside the pod container, so review auth follows the same
profile-provisioned credentials as the agent runtime".

The dedicated browser-script bridge method should be explicit, for example
`generateBrowserValidationScript(podId, prompt)`, and should use the live
container plus the profile reviewer model/provider. For Max/Pro profiles it
should run Claude CLI in the pod container. For OpenAI and Foundry OpenAI-surface
profiles it should run Codex CLI in the pod container. For Foundry
Anthropic-surface profiles it should run Claude CLI in the pod container. If the
container reviewer path is unavailable or unsupported, return a clear error and
do not fall back to `createProfileAnthropicClient` or other daemon-side direct
SDK/API-key billing credentials.

Preserve the existing `validate_in_browser` behavior around localhost URL
validation, URL rewriting for host execution, markdown fence stripping, result
marker parsing, screenshots, and container fallback execution. The change is
only about how the Playwright script is generated.

## Skills to reference
None beyond `/prep`. The scan found no `Profile` field or `PodStatus` changes,
so do not invoke `/add-profile-field` or `/add-pod-state`.

## Test expectations
Update `packages/escalation-mcp/src/tools/validate-in-browser.test.ts` so the
tool-level tests prove script generation calls the new dedicated bridge method
and no longer calls `callReviewerModel`. Keep existing coverage for localhost
rejection, empty checks, host-side execution, host failure fallback to container
execution, result parsing, and screenshot collection.

Update `packages/daemon/src/pods/pod-bridge-validation.test.ts` with a
Max/Pro-style profile test where a live pod container generates the browser
validation script through the container Claude CLI reviewer path and
`createProfileAnthropicClient` is not called. Also cover the clear failure when
the bridge cannot use a live container reviewer path.

If the advisory QA container reviewer code is extracted, keep
`packages/daemon/src/validation/advisory-browser-qa-runner.test.ts` green and
add focused helper tests in
`packages/daemon/src/validation/container-reviewer-runner.test.ts` for the
shared Claude/Codex routing if the extraction leaves behavior that is no longer
directly covered.

## Risks / pitfalls
Adding a method to `PodBridge` can break typed test stubs in files that are not
behaviorally part of this change. Update those stubs mechanically, without
changing route or server behavior.

Foundry must remain compatible through the shared container reviewer helper, but
this brief does not require a separate Foundry proof. Token-auth Foundry
profiles depend on already-injected container credentials; if those credentials
are unavailable or stale from the bridge path, fail clearly rather than adding a
daemon-side SDK fallback.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
