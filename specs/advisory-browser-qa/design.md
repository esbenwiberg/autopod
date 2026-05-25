# Design - Advisory Browser QA

## Blast radius
- Shared contracts: `packages/shared/src/types/profile.ts`,
  `packages/shared/src/schemas/profile.schema.ts`,
  `packages/shared/src/types/pod-options.ts`,
  `packages/shared/src/types/validation.ts`, `packages/shared/src/evidence.ts`.
- Daemon profile/config: `packages/daemon/src/db/migrations/`,
  `packages/daemon/src/profiles/profile-store.ts`,
  `packages/daemon/src/profiles/profile-validator.ts`,
  `packages/daemon/src/pods/pod-manager.ts`.
- Daemon validation: `packages/daemon/src/validation/local-validation-engine.ts`,
  new `packages/daemon/src/validation/advisory-browser-qa-runner.ts`,
  `packages/daemon/src/api/wire-serializers.ts`,
  `packages/daemon/src/api/routes/screenshots.ts`.
- CLI: `packages/cli/src/commands/profile.ts`.
- Desktop profile UI: `ProfileResponse.swift`, `Profile.swift`,
  `ProfileMapper.swift`, `ProfileFieldCatalog.swift`, `ProfileEditorView.swift`.
- Desktop validation UI: `ValidationResponse.swift`, `Pod.swift`,
  `PodMapper.swift`, `ValidationTab.swift`.

## Seams
- Shared contracts -> daemon persistence. Brief 01 owns the type/schema surface;
  brief 02 owns storage, validation, CLI, and pod-manager effective config.
- Daemon config -> advisory runner. Brief 02 passes the effective setting into
  `ValidationEngineConfig`; brief 03 consumes it in local validation.
- Advisory runner -> wire result. Brief 03 stores internal screenshot refs in
  `ValidationResult.advisoryBrowserQa`; brief 05 decodes/render them in desktop.
- Profile setting -> desktop editor. Brief 04 wires the profile field after the
  shared contract exists and before result rendering depends on user control.

## Contracts
```ts
export interface Profile {
  advisoryBrowserQaEnabled: boolean | null;
}

export interface PodOptions {
  advisoryBrowserQa?: boolean;
}

export interface AdvisoryBrowserQaResult {
  status: 'skip' | 'complete' | 'error';
  reason?: 'disabled' | 'non-web-profile' | 'upstream-not-green' | 'no-contract-checklist' | 'browser-unavailable' | 'runner-error';
  summary?: string;
  observations: AdvisoryBrowserQaObservation[];
  skippedTargets?: AdvisoryBrowserQaTarget[];
  screenshots: ScreenshotRef[];
  durationMs: number;
  error?: string;
}

export interface AdvisoryBrowserQaObservation {
  id: string;
  kind: 'scenario' | 'human_review';
  targetId: string;
  verdict: 'appears_satisfied' | 'concern' | 'not_checked';
  notes: string;
  screenshots: ScreenshotRef[];
}
```

`ScreenshotSource` gains `'advisory'`. The screenshot route must accept it, and
wire serializers must turn advisory `ScreenshotRef` values into DTO URLs the
same way they do for smoke/fact/review screenshots.

The effective run policy is:
- profile `null` means auto-enable when effective `hasWebUi` is true;
- profile `true` enables for web UI pods;
- profile `false` disables;
- pod option `advisoryBrowserQa` wins over profile default;
- run only after lint/SAST/build/test/health/pages/facts/review are green or
  nonblocking;
- cap guided attempts at 5 checklist targets per validation attempt;
- skip with `no-contract-checklist` when both `scenarios` and `human_review`
  are empty.

## UX flows
Validation tab entrypoint: user opens a completed validation result, then clicks
the neutral Advisory QA chip after Review.

```text
Lint | SAST | Build | Tests | Health | Pages | Facts | Review | Advisory QA

Summary counts blocking phases only.
Advisory QA opens a neutral detail panel.
Concerns do not make validation red.
```

Advisory detail states:
- **Complete** - summary plus observations grouped by scenario/human_review id,
  with verdict labels and screenshot thumbnails.
- **Skipped** - concise skip reason, e.g. no contract checklist or non-web
  profile.
- **Error** - advisory error text, styled neutral/amber, while validation summary
  remains based on blocking phases.

## Reference reading
- `docs/ideas/scenario-browser-qa.md` - existing product framing: advisory
  evidence is useful, blocking validation should remain fact-driven.
- `docs/decisions/ADR-017-screenshots-on-disk-with-retention.md` - screenshot
  storage and URL model to extend with `advisory`.
- `AGENTS.md` - migration numbering and Autopod package conventions.
- `packages/daemon/CLAUDE.md` - daemon subsystem map.
- `packages/daemon/src/validation/local-validation-engine.ts` - validation
  phase ordering and overall computation.
- `packages/daemon/src/validation/host-browser-runner.ts` - existing host
  Playwright execution seam.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift` -
  existing phase chip row and detail panel.
- `/Users/ewi/repos/autopod/.agents/skills/add-profile-field/SKILL.md` - full
  profile field checklist required by this feature.

## Decisions
- ADR-027: Advisory browser QA is evidence, not validation (introduced).
- ADR-017: Proof-of-work screenshots on disk with retention (existing).
