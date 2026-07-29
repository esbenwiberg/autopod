---
title: "Add daemon Podsitter CLI operations"
touches:
  - packages/cli/src/index.ts
  - packages/cli/src/api/client.ts
  - packages/cli/src/commands/podsitter.ts
  - packages/cli/src/commands/podsitter.test.ts
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/desktop/
  - packages/mobile-web/
require_sidecars: []
---

## Task

Add `ap podsitter` commands for dedicated-account configuration, always-on or recurring authorization, expiry, kill switch, status, read-only/manual reconciliation, provider probing, and redacted decision history.

## Motivation

The daemon feature must be operable without a Pi session or desktop. CLI configuration is also the fastest path for hosted-daemon rollout and overnight use.

## Repository findings

- `packages/cli/src/commands/provider-account.ts` already lists and authenticates provider accounts and can provide compatible selection/error patterns.
- `packages/cli/src/api/client.ts` centralizes authenticated daemon requests.
- Existing command tests use Commander harnesses and JSON output helpers.

## Approved approach

Implement the commands from `design.md`:

```text
ap podsitter configure --account <id> --runtime <runtime> --model <model>
ap podsitter on --always [--until <iso|duration>]
ap podsitter on --cron <expr> --duration <duration> --timezone <iana> [--until ...]
ap podsitter off
ap podsitter status [--json]
ap podsitter check
ap podsitter probe
ap podsitter decisions [--pod <id>] [--json]
```

Use daemon validation as authoritative, with helpful client-side checks for mutually exclusive activation options and duration parsing. `off` must clearly identify itself as the immediate daemon kill switch. `check` must state when it was read-only because authorization was inactive. Status renders enabled/active/expiry, activation details, dedicated account/runtime/model, provider circuit/next probe, pending count, and last action without credential material.

Do not reimplement polling or decisions in the CLI. Do not invoke existing pod action routes directly. This command controls the daemon-native feature; documentation/output should distinguish it from Pilot's local `/podsitter` extension.

## Scope boundaries

No daemon, shared, desktop, mobile, or Pilot extension changes. No provider login flow beyond referring operators to existing `ap provider-account` commands.

## Constraints

- Require exactly one of `--always` or `--cron` when changing activation.
- Recurring mode requires duration and timezone.
- Parse human durations deterministically and send canonical API values.
- Confirmation for `off` may be bypassable with standard noninteractive/JSON conventions, but automation must not hang.
- JSON output must remain machine-readable and contain redacted API data only.
- Error messages must preserve provider-limited next-probe and incompatible-account details.

## Test expectations

Cover configure, always-on, recurring cross-midnight input, expiry, off, status text/JSON, inactive check, probe, decision filtering/pagination, malformed durations/timezones/options, and daemon errors. Assert exact API methods/payloads and no local pod action commands.

## Required-fact sanity

- A CLI that stores settings locally or starts its own timer must fail `fact-cli-daemon-control`.
- A recurring command that omits timezone/duration must fail `fact-cli-activation-validation`.
- A status renderer exposing credentials or dropping provider circuit state must fail `fact-cli-redacted-status`.

## Risks

`podsitter` already names a Pilot slash command, so help text must make the daemon versus local-session distinction obvious. Avoid a confirmation prompt that breaks unattended `ap podsitter off` automation.

## Wrap-up

Before finishing:
1. Run focused CLI tests, build, and typecheck.
2. Verify JSON output and error paths.
3. Run the profile finish prompt if configured.
4. Commit and push.
