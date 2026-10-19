# Slice 18 research: runtime resume context

Date: 2026-10-18. Branch: codex/pod-manager-workspace.
Baseline: f09e687bc338aac1c10bff80d88315a8b02e74c8.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
State: Planning only. No product/test changes or implementation tests run.

## Current behavior

pod-manager.ts is 16,602 lines. primeRuntimeForResume is at :3012–3100 (89 lines).
It resolves executionForPod before reading launch. A native Goal launch fails with
GOAL_NATIVE_RESUME_REQUIRED/409 before capability/credential/token/runtime work.
For a task launch, an optional live capability check precedes the existing shared
executionCredentialsFor(launch)?.agent(launch) call. No launch skips both. Missing
adapter follows the existing resolver's credential-reference policy; with no
references it can yield no material. Resolved material shallowly overlays the
initial profile; the original passed env argument is not replaced with material.buildEnv.

The helper constructs a pod escalation URL and obtains an optional token from the
live deps.sessionTokenIssuer. A truthy token creates one Authorization header object
shared by escalation and daemon-proxied HTTP entries; no token keeps explicit
headers:undefined properties. mergeMcpServers preserves insertion order and lets
profile entries override daemon entries by name. Non-stdio entries become daemon
proxy URLs with encodeURIComponent(server.name), using escalation headers rather
than original remote URL/headers. This helper builds configuration, not connections.

Array order is escalation, merged HTTP, code-intelligence stdio, then launch-only
configured stdio. Code-intelligence mapping conditionally includes args/env; launch
configured stdio mapping retains explicit args/env properties, even undefined.
Legacy configured stdio is omitted on this path. No new deduplication is applied
across escalation/code-intelligence/configured entries. The existing separate
buildCodeIntelligenceServers helper remains in manager and is used elsewhere.

A second optional live capability check follows MCP construction and precedes
reasoning selection/runtime setters. Each check/service/token lookup uses the
original deps object and current receiver; no service cache exists. The launch
argument remains the initial saved object across awaits. Profile/pod/env inputs
retain their original reference and read timing. Failure propagates without a catch;
a generated token/earlier setter effect is not undone if a later step fails.

resolvedReasoningEffort receives the selected profile and current pod.profileSnapshot
with the original cast. Its existing callback implements snapshot > profile > auto.
Pi conditionally sets a truthy session id, then unconditionally calls setPiResumeConfig
with task:'', customInstructions:'resume', /workspace, passed container/env (or {}),
model/reasoning and MCP array. Claude guards only presence of setClaudeResumeConfig,
then conditionally calls setClaudeSessionId and always its config setter. Codex
guards only setCodexResumeConfig and does not restore a Codex session id here.
Copilot/unsupported setter cases return the MCP list without those setter calls.
No runtime spawn/resume, container I/O, lifecycle mutation or provenance work is
performed by this helper itself.

## Callers and collaborators

Three direct awaited calls:
- taskFeedbackEvents :2995, after getResumeEnv and continuation provenance; its
  fresh flag then selects runtime.resume or runtime.spawn using returned MCP config.
- Pi processPod crash recovery :9377, after existing attempt rotation; builds its
  continuation prompt and resumes afterward.
- sendMessage :10796, after environment/provenance and preserved-sandbox handling;
  returned MCP config is also used by the missing-Claude-session fallback spawn.

Initial Claude/Codex crash-recovery configuration at :9269/:9359 is separate inline
logic, not a call to this helper. Do not count those tests as proof of the helper's
Pi recovery call, and do not move those blocks as part of this extraction.
All caller flow, preflight, fallbacks, dispatch and cleanup remain in manager.

Dependencies are a live read/capability launch view plus optional token generator,
and six captured references: executionForPod, executionCredentialsFor,
injectionsForPod, mcpBaseUrl, buildCodeIntelligenceServers, resolvedReasoningEffort.
mergeMcpServers comes from pods/injection-merger.ts. Runtime class references here
are type casts; new module may use type imports. Existing manager imports all still
have other consumers, so this extraction needs no existing named-import removal.

## Existing evidence and next action

pod-manager.test.ts:19401 pins durable Pi session/config/snapshot reasoning and pod
bearer token on public sendMessage. :13602 pins separate inline Codex recovery.
worker runtime credential compatibility (:30192) pins message/rejection preparation;
fresh runtime provenance and blocked-resume groups retain admission coverage.
Existing Claude/Codex/Pi runtime suites test stored resume state and controlled local
invocation, injection-merger.test.ts tests override/order, crypto/pod-tokens.test.ts
tests real token behavior. None of these five paths is in predecessor's 86-suite list.
New direct suite plus these five makes 92 distinct affected suites.

Checkout is clean at baseline. Primary checkout remains unrelated and dirty; preserve
it. Existing Node22.23.3/pnpm9.15.4/SQLite3.49.2 qualification harness and source-hash
rules remain available under .autopod-data/validation-environment/.
Next: present a plan with the existing characterize → extract → qualify structure
and await explicit approval before changing product/tests. No unresolved design choice.
