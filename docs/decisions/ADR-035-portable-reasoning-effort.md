# ADR-035: Portable common-subset reasoning effort

## Status

Accepted

## Context

Claude Code, Codex, GitHub Copilot CLI, and Pi each expose a control for how much reasoning or
work an agent requests, but their names, accepted values, and defaults differ. Leaving this choice
implicit makes profile behavior vary when operators switch runtimes or provider failover starts a
new attempt. Exposing each provider's full vocabulary would make profiles runtime-specific and
would create values that cannot be preserved across all supported workers.

Reasoning effort is a behavioral request, not a strict token budget. Runtime and model defaults
also evolve, so Autopod needs an explicit way to retain those native defaults without guessing what
they currently mean.

## Decision

Add one provider-neutral profile reasoning-effort setting with the values `auto`, `low`, `medium`,
`high`, and `xhigh`. The four non-auto values are the common subset supported by Claude Code,
Codex, GitHub Copilot CLI, and Pi. Do not expose provider-specific values such as `off`, `minimal`,
`max`, or product modes such as OpenAI Pro and Claude fast mode through this contract.

`auto` means Autopod omits the runtime-specific effort or thinking control so the selected
runtime, model, and account retain their native default. Autopod does not translate `auto` into a
concrete level.

Profiles inherit reasoning effort like other replace-or-inherit fields. New base profiles resolve
to `auto`; a raw derived profile may store `null` to inherit; an explicit child value replaces its
parent. The resolved value is fixed for a provider attempt and is carried unchanged into runtime
continuations, respawns, and the next attempt during provider failover.

Runtime adapters map a non-auto value at invocation scope:

- Claude Code: `--effort <value>`
- Codex: `model_reasoning_effort = "<value>"` in the pod-local invocation configuration
- GitHub Copilot CLI: `--effort <value>`
- Pi: `--thinking <value>`

Runtime configuration stays inside the pod boundary. In particular, Codex integration must not
write or mutate user-global configuration and must preserve existing pod-local MCP configuration,
timeouts, and secure file permissions.

## Consequences

Easier:

- Operators get one predictable quality, latency, and token-use control across all agent runtimes.
- Runtime continuation and provider failover preserve the operator's selected intent.
- `auto` follows future runtime and model defaults without Autopod hard-coding an approximation.
- Profiles remain portable instead of accumulating provider-specific effort values.

Harder:

- Every runtime adapter and continuation path must preserve the resolved setting consistently.
- The shared contract is intentionally narrower than some providers' native controls.
- Runtime CLI and configuration changes require adapter tests to keep invocation syntax current.

Committed to:

- The portable `auto`, `low`, `medium`, `high`, and `xhigh` vocabulary.
- Omission, rather than guessed translation, for `auto`.
- One resolved value per provider attempt, preserved across continuation and failover.
- Pod-local runtime configuration with no mutation of user-global settings.
