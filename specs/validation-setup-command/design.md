# Design - Validation Setup Command

## Blast radius
- Shared contracts: `packages/shared/src/types/profile.ts`,
  `packages/shared/src/schemas/profile.schema.ts`,
  `packages/shared/src/types/events.ts`, and
  `packages/shared/src/types/validation.ts`.
- Daemon profile/config: `packages/daemon/src/db/migrations/`,
  `packages/daemon/src/profiles/profile-store.ts`,
  `packages/daemon/src/profiles/profile-validator.ts`,
  `packages/daemon/src/interfaces/validation-engine.ts`, and
  `packages/daemon/src/pods/pod-manager.ts`.
- Daemon validation: `packages/daemon/src/validation/local-validation-engine.ts`,
  `packages/daemon/src/pods/correction-context.ts`, and
  `packages/daemon/src/pods/feedback-formatter.ts`.
- Agent self-validation: `packages/escalation-mcp/src/pod-bridge.ts`,
  `packages/escalation-mcp/src/server.ts`,
  `packages/escalation-mcp/src/tools/validate-locally.ts`, and
  `packages/daemon/src/pods/pod-bridge-impl.ts`.
- CLI: `packages/cli/src/commands/profile.ts`.
- Desktop profile UI: `ProfileResponse.swift`, `Profile.swift`,
  `ProfileMapper.swift`, `ProfileFieldCatalog.swift`, and
  `ProfileEditorView.swift`.
- Desktop validation UI: `EventTypes.swift`, `ValidationResponse.swift`,
  `Pod.swift`, `PodMapper.swift`, `ValidationTab.swift`, and
  `FeatureOverviewView.swift`.

## Seams
- Shared profile contract -> daemon persistence. Brief 01 owns the
  `validationSetupCommand` field, storage, validation, skip-phase enum, and CLI
  exposure.
- Profile config -> daemon validation. Brief 02 consumes the stored setup
  command in `ValidationEngineConfig` and runs it before all downstream phases.
- Daemon phase execution -> agent self-validation. Brief 03 exposes setup
  through the pod bridge and makes `validate_locally` prepend setup before any
  requested phase set.
- Profile setting -> desktop editor. Brief 04 wires the new profile field into
  Desktop profile editing.
- Validation result/event -> desktop validation timeline. Brief 05 renders Setup
  as the first validation chip and detail panel.

## Contracts
```ts
export interface Profile {
  validationSetupCommand?: string | null;
  skipValidationPhases?: Array<
    | 'setup'
    | 'lint'
    | 'sast'
    | 'build'
    | 'tests'
    | 'health'
    | 'pages'
    | 'facts'
    | 'review'
  >;
}

export type ValidationPhase =
  | 'setup'
  | 'build'
  | 'test'
  | 'lint'
  | 'sast'
  | 'health'
  | 'pages'
  | 'facts'
  | 'review'
  | 'advisory';

export interface SetupResult {
  status: 'pass' | 'fail' | 'skip';
  output: string;
  duration: number;
  error?: string;
}

export interface ValidationResult {
  setup?: SetupResult;
  // existing result fields remain unchanged
}

export interface ValidationEngineConfig {
  validationSetupCommand?: string | null;
  buildTimeout?: number;
  skipPhases?: ValidationPhase[];
}

export type ValidationPhaseName = 'setup' | 'lint' | 'build' | 'tests';
```

`ValidationPhaseCompletedEvent` gains an optional `setupResult` field that
matches the setup result shape. Existing clients must continue tolerating
missing setup data on historical validation attempts.

## Run policy
- Setup runs before lint, SAST, build, tests, health, pages, facts, and review.
- Empty or missing `validationSetupCommand` produces a neutral skipped setup.
- `skipValidationPhases` may include `setup`; skipped setup is neutral and does
  not block downstream phases.
- Setup failure sets overall validation to fail and stops downstream phases
  immediately. Downstream deterministic phases should be represented as skipped
  or not run, not executed after a failed setup.
- Setup uses the existing `buildTimeout` value. Desktop labels the shared
  timeout as `Build + Setup`.
- Setup runs on every validation attempt and every `validate_locally` call. No
  "setup already passed" cache is introduced.
- `buildCommand` remains the build phase. Existing profiles are not migrated or
  rewritten automatically.

## Agent self-validation policy
- Default `validate_locally` order becomes `setup`, `lint`, `build`, `tests`.
- `validate_locally({ phases: ['lint'] })` runs setup first when setup is
  configured and not skipped, then lint.
- Setup is prepended on every call, even if a previous call already ran setup.
- If setup fails, requested downstream phases are skipped and the tool returns
  `passed: false`.
- If setup is missing or skipped by profile, it is neutral and requested phases
  continue normally.

## UX flows
Validation tab entrypoint: the user opens a validation attempt. Setup appears as
the first blocking phase.

```text
[ Setup ] [ Lint ] [ SAST ] [ Build ] [ Tests ] [ Health ] [ Pages ] [ Facts ] [ Review ]
   red      gray     gray      gray      gray      gray       gray      gray      gray

Setup needs attention
Setup failed. Downstream validation phases were skipped.

Setup Output
pip install ...
error: ...
```

Profile editor entrypoint: the user edits a base or derived profile in Build &
Run settings.

```text
Build Command        [ npm run build                         ]
Validation Setup     [ pip install -e ".[dev]" semgrep        ]
Test Command         [ pytest                                ]
Lint Command         [ ruff check . && ruff format --check . ]
SAST Command         [ semgrep ...                           ]

Timeouts
Health [120s]  Build + Setup [600s]  Test [600s]  Lint [120s]  SAST [300s]
```

## Reference reading
- `AGENTS.md` - migration numbering, `npx pnpm`, and Autopod package map.
- `docs/conventions/convention-001-autopod-self-required-facts.md` - desktop
  Swift/Xcode validation is human review or optional local verification for
  Autopod-self.
- `/Users/ewi/repos/autopod/.agents/skills/add-profile-field/SKILL.md` - full
  profile field checklist required across the series.
- `packages/daemon/src/validation/local-validation-engine.ts` - current
  validation phase ordering.
- `packages/escalation-mcp/src/tools/validate-locally.ts` - agent
  self-validation phase ordering and skip behavior.
- `packages/daemon/src/pods/pod-bridge-impl.ts` - daemon-side execution bridge
  for MCP validation phases.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift` -
  existing validation phase row and detail panel.
- `specs/advisory-browser-qa/` - existing profile-field and desktop split
  pattern.

## Decisions
- ADR-029: Validation setup is a first-class blocking phase.
