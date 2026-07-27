# ADR-035: Portable common-subset reasoning effort

## Status

Accepted

## Context

Autopod supervises Claude Code, Codex, GitHub Copilot CLI, and Pi through one runtime interface. Each runtime now exposes a reasoning or effort control, but their full ranges differ:

- Claude Code: `low`, `medium`, `high`, `xhigh`, `max`
- Codex: `minimal`, `low`, `medium`, `high`, and model-dependent `xhigh`
- GitHub Copilot CLI: `low`, `medium`, `high`, `xhigh`
- Pi: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`

Profiles can fail over between provider accounts and runtimes under ADR-034. A provider-specific setting or a widest-union enum would therefore require silent clamping, failure during a later attempt, or provider-dependent semantic translation. Omitting an override also matters because provider defaults differ: Claude 5 defaults to high while Codex commonly defaults to medium.

## Decision

Add one profile-level `reasoningEffort` contract with:

```text
auto | low | medium | high | xhigh
```

`auto` means Autopod emits no runtime-specific effort/thinking option. It does not resolve to a guessed value.

Every non-auto value is passed through unchanged:

- Claude Code: `--effort <value>`
- Codex: `model_reasoning_effort = "<value>"` for the invocation
- GitHub Copilot CLI: `--effort <value>`
- Pi: `--thinking <value>`

The value is inherited with the rest of the profile, carried in `SpawnConfig`, and preserved across continuation, suspension/resume, and provider attempts. This first contract applies only to the main agent runtime. Reviewer/helper calls and per-pod overrides are separate future decisions.

## Consequences

Easier:

- One profile has stable semantics across every supported runtime and failover target.
- `auto` honestly preserves provider/model/account defaults instead of pretending they are uniform.
- Runtime adapters remain responsible only for syntax, not policy or translation.

Harder:

- Provider-only `off`, `minimal`, and `max` capabilities are not configurable through this field.
- Model-specific support changes may require validation or a future capability catalog if the common subset stops being universal.
- Operators wanting maximum provider-specific control need a later, explicitly non-portable override design.

Committed to:

- No silent clamping or nearest-level translation.
- No guessed default for `auto`.
- No coupling main-agent effort to reviewer/helper calls.
- No per-pod override in the initial contract.

## Alternatives rejected

- **Independent fields per runtime.** Precise but cumbersome in the profile editor and ambiguous under cross-runtime failover.
- **Widest-union enum.** Exposes all provider values but forces launch-time failure or silent downgrade on unsupported runtimes.
- **Map generic low/medium/high to provider-specific budgets.** Hides semantics and would drift as providers change their models and defaults.
- **Set one explicit default such as high.** Changes current Codex behavior and removes the provider/account default escape hatch.
