# Native Goal observations for composable configuration

Observed locally on 2026-09-14. These are implementation fixtures, not acceptance receipts for a real provider or the production runtime image. Production Goal capability remains disabled.

## Codex 0.152.1: stored Goal inspection

The installed `/opt/homebrew/bin/codex` ran with isolated homes, a shared fixture SQLite directory, an empty fixture workspace and a local rejecting provider. The first app-server created a thread and stored a paused Goal. It exited. A second app-server using a fresh home initialized and issued only stored-Goal get/set operations plus loaded-thread list checks.

The saved objective and zero counters were preserved. The loaded-thread list remained empty before and after inspection. The local provider received zero requests. No real account credentials were supplied.

Fixture script: `/private/tmp/autopod-native-goal-inspection-fixture.py`.
Result: `/private/tmp/autopod-native-goal-inspection-fixture.log`.

This supports inspection without `thread/resume`, which matters because loading an active native Goal can start continuation. The implementation first stops the recorded agent execution and then inspects with an empty credential environment. Recovery inspectors also receive durable process records.

## Docker execution recovery

`packages/daemon/src/containers/native-goal-recovery.docker.test.ts` passed against the local Docker socket using cached Node image `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`. The fixture had no network, host bind mounts or credentials, ran as UID 1000, and limited memory/processes.

An execution identity was captured before start. A fresh container-manager instance terminated that exact execution group and observed its exit through Docker. A separate execution in the same container remained running. Repeating recovery returned the observed exit. The fixture container was removed.

Database tests separately cover the original account/configuration/container/attempt binding, cancelled controls, lost inspection handles, usage deltas, duplicate recovery and unacknowledged start claims. An unacknowledged start is not automatically released: a stop attempt does not prove that a previously outstanding start request cannot still arrive. This scenario remains a release blocker for complete automatic recovery.

## Claude Code 2.1.270: native lifecycle and usage differ

The installed Claude binary ran with an isolated home/config directory, no tools, and a local fake Anthropic-compatible provider. It received a native `/goal` command. The fixture served one main-model response and one evaluator response, each reporting seven input tokens and three output tokens. There were no real provider calls or charges. The CLI's cost fields were calculations over fixture usage, not billing evidence.

The persisted transcript included native `attachment.type = goal_status` records:

- The initial sentinel had `met: false`, `sentinel: true` and the exact condition.
- The completed record had `met: true`, the exact condition, a reason, `iterations: 1`, a duration and `tokens: 6`.

The stream result reported `terminal_reason: completed`. Its ordinary `usage` contained only seven input and three output tokens. Its `modelUsage` map contained both models, each with seven input and three output tokens: twenty total fixture tokens. Therefore neither the completion attachment's `tokens` nor ordinary result `usage` is complete main-plus-evaluator accounting. Assistant prose and a successful process exit are also not native Goal completion evidence.

Fixture script: `/private/tmp/autopod-claude-goal-local-fixture.py`.
Result: `/private/tmp/autopod-claude-goal-local-fixture.log`.
The isolated native transcript and fake-provider requests remain under `/private/tmp/autopod-claude-goal-fixture-htlemob4`.

This is enough to identify useful native records, but it does not establish complete evaluator accounting when a process dies before the final result. An observable Claude adapter and interrupted-run accounting still need implementation and verification. Capability discovery explicitly refuses Claude Goals, even if an operator supplies a receipt for that runtime.

Claude's documentation confirms native non-interactive Goal invocation, evaluator billing, persisted active conditions on resume and reset token-spend baselines. Those documented behaviors do not establish the missing interrupted-run telemetry contract. [Claude native Goals](https://code.claude.com/docs/en/goal).

## Acceptance still required

A real provider journey must cover start, continuation, completion, cancellation, explicit resume, daemon restart, cumulative usage including evaluation, and confirmed termination for the exact runtime version, image digest, backend and selected provider. Local backend proof, a synthetic provider and operator-supplied metadata do not substitute for that journey. Managed Goals remain unavailable in the current Dispatcher contract; Sandbox process recovery is also unavailable.
