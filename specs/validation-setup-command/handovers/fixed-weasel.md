# fixed-weasel Handover

## Built

- Added `SetupResult` and optional `ValidationResult.setup` to shared validation types.
- Added optional `setupResult` to `ValidationPhaseCompletedEvent`.
- Added `validationSetupCommand?: string | null` to `ValidationEngineConfig`.
- Local daemon validation now runs setup immediately after worktree reset and before lint, SAST, build, tests, health, pages, facts, and review.
- Setup uses the existing build timeout and validation exec environment.
- Missing setup commands and profile-skipped setup produce neutral skipped setup results.
- Failed setup returns overall validation failure immediately with lint, SAST, tests, health, facts, and review marked skipped/not run.
- Pod manager now passes profile setup commands into validation, emits setup phase events, and lists setup first in validation summaries and validation waiver failed phases.
- Correction context and feedback formatting now prioritize setup failures before downstream failures.

## Deviations

- The shared `BuildResult.status` union still only supports `pass | fail`, and the design said existing result fields remain unchanged. When setup fails, the returned build result uses the existing neutral skipped-build convention, while pod-manager summaries display build as `skip` whenever setup failed.
- The brief says commit and push, but the pod operating environment says not to run `git push`; changes were committed locally and the host system is expected to push.

## Changed Interfaces

- `ValidationResult.setup?: SetupResult`
- `SetupResult = { status: 'pass' | 'fail' | 'skip'; output: string; duration: number; error?: string }`
- `ValidationPhaseCompletedEvent.setupResult?: SetupResult`
- `ValidationEngineConfig.validationSetupCommand?: string | null`

## Owned Files

The next pod should not modify these without a specific reason:

- `packages/shared/src/types/validation.ts`
- `packages/shared/src/types/events.ts`
- `packages/daemon/src/interfaces/validation-engine.ts`
- `packages/daemon/src/validation/local-validation-engine.ts`
- `packages/daemon/src/validation/local-validation-engine.test.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/pods/pod-manager.test.ts`
- `packages/daemon/src/pods/correction-context.ts`
- `packages/daemon/src/pods/correction-context.test.ts`
- `packages/daemon/src/pods/feedback-formatter.ts`
- `packages/daemon/src/pods/feedback-formatter.test.ts`

## Constraints And Landmines

- Historical validation rows will not have `setup`; all consumers must keep treating the field as optional.
- `skipPhases` uses the shared `ValidationPhase` spelling `test`, not the UI label `tests`.
- Setup phase events are emitted for configured/missing setup commands. Profile-skipped setup follows existing profile-skip phase behavior: completion is emitted as `skip`, but no phase-start event is emitted.
- A failed setup intentionally does not run downstream command phases. Tests assert only the setup command executes.
- Desktop and MCP `validate_locally` were intentionally not changed in this brief.
