---
title: "Add daemon Podsitter desktop settings and audit"
touches:
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodClient/Types/PodsitterResponse.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/PodsitterStore.swift
  - packages/desktop/Sources/AutopodDesktop/Views/SettingsView.swift
  - packages/desktop/Sources/AutopodDesktop/Views/PodsitterSettingsView.swift
  - packages/desktop/Tests/AutopodClientTests/
  - packages/desktop/Tests/AutopodDesktopTests/
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/mobile-web/
require_sidecars: []
---

## Task

Add a macOS desktop settings surface for configuring and operating daemon-native Podsitter: dedicated provider account/runtime/model, always-on or recurring activation, optional expiry/profile scope, provider health, immediate kill switch, manual check/probe, and recent redacted decisions.

## Motivation

Full autonomous authority needs visible, auditable configuration and a prominent kill switch. Operators should understand whether the daemon is enabled, currently authorized, provider-limited, or draining deferred work without using CLI or keeping Pi open.

## Repository findings

- `SettingsView.swift` already uses a sidebar-based settings layout.
- Existing provider-account APIs and profile editor controls provide account/runtime/model selection patterns without exposing credentials.
- `DaemonAPI.swift` and store patterns centralize authenticated requests and observable state.

## Approved approach

Add a `Podsitter` item to existing Settings, not a new application window. Use this compact layout:

```text
Settings > Podsitter

[ Enabled / inactive / provider limited ]       [DISABLE NOW]
Decision model
  Account [Dedicated Sitter Account v]
  Runtime [Codex v]   Model [gpt-... v]

Authorization
  ( Always on )  ( Recurring )
  Recurring: [0 20 * * *] [12h] [Europe/Copenhagen]
  Optional expiry [date/time | none]
  Profile scope [All profiles | selected...]

Provider
  quota_exhausted · next probe 03:15     [Probe now]
Pending: 3 · Last action: waived fact-x on abcd1234
                                              [Check now]

Recent decisions
  time · pod · action · outcome · reason · remaining risk
```

The destructive-looking kill switch must remain visible whenever enabled and require a concise confirmation that explains it invalidates in-flight authority but does not kill normal pods. Enabling full parity must clearly state the action classes include approvals, waivers, retries, recovery, force approval, validation skipping, and force completion.

Populate the account picker from existing redacted provider accounts and filter runtime choices by compatibility. Do not add provider login in this view; link to existing provider account management when the account is unauthenticated. Disable save/enable for invalid activation or incompatible target.

Status should refresh from API/events and show enabled versus currently active, expiry, recurring next window, provider circuit/next probe, deferred count, and last action. Decision rows show evidence references/reason/risk/outcome but never raw prompt, full logs/diff, or credentials.

## Scope boundaries

Do not modify daemon/shared/CLI/mobile code. Do not expose buttons for individual pod actions; all interventions remain daemon decisions. Do not add per-action toggles in the first release.

## Constraints

- Use redacted API types only.
- Distinguish configured/enabled/currently active/provider available states.
- Always-on and recurring controls are mutually exclusive; recurring requires cron, positive duration, and timezone.
- Kill switch calls daemon disable and updates UI even if an in-flight decision later appears as not executed.
- Surface API/provider errors without losing the last known status.
- Preserve existing Settings navigation and provider-account/profile behavior.

## Test expectations

Add API decoding/request tests, store tests for load/configure/enable/disable/check/probe/history and failure retention, plus view-model/UI behavior tests for state labels, target compatibility, activation validation, full-authority warning, kill-switch confirmation, provider-limit recovery display, and decision redaction.

## Required-fact sanity

- A view that equates enabled with currently active must fail `fact-desktop-state-distinction`.
- A kill switch that only changes local state must fail `fact-desktop-daemon-kill-switch`.
- A configuration flow that allows recurring activation without duration/timezone or hides full-parity authority must fail `fact-desktop-authorization-editor`.
- A history view rendering raw prompts/credentials must fail `fact-desktop-redacted-history`.

## Risks

Swift decoding can become brittle as provider-circuit states evolve; use explicit enums with an unknown fallback where existing conventions allow. Full-parity authorization must not be hidden behind a generic toggle. Keep the view compact while making expiry and provider-limit status unmistakable.

## Wrap-up

Before finishing:
1. Run focused Swift package tests and `xcodebuild` where available.
2. Verify VoiceOver labels and disabled/error states.
3. Run the profile finish prompt if configured.
4. Commit and push.
