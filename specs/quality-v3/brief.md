---
title: "Separate process health from outcome quality"
touches:
  - packages/daemon/src/pods/quality-activity.ts
  - packages/daemon/src/pods/quality-activity.test.ts
  - packages/daemon/src/pods/quality-signals.ts
  - packages/daemon/src/pods/quality-signals.test.ts
  - packages/daemon/src/pods/quality-score.ts
  - packages/daemon/src/pods/quality-score.test.ts
  - packages/daemon/src/pods/quality-score-recorder.ts
  - packages/daemon/src/pods/quality-score-recorder.test.ts
  - packages/daemon/src/pods/quality-score-repository.ts
  - packages/daemon/src/pods/quality-score-repository.test.ts
  - packages/daemon/src/pods/models-aggregator.ts
  - packages/daemon/src/pods/models-aggregator.test.ts
  - packages/daemon/src/pods/memory-effectiveness-aggregator.ts
  - packages/daemon/src/pods/memory-effectiveness-aggregator.test.ts
  - packages/daemon/src/pods/readiness-review.ts
  - packages/daemon/src/pods/readiness-review.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/db/migrations/135_quality_score_v3.sql
  - packages/shared/src/index.ts
  - packages/shared/src/types/pod.ts
  - packages/shared/src/types/analytics.ts
  - packages/desktop/Sources/AutopodClient/Types/
  - packages/desktop/Sources/AutopodUI/Views/Analytics/
  - packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/
  - packages/desktop/Sources/AutopodUI/Views/Features/
  - packages/desktop/Sources/AutopodUI/Views/Series/SeriesPipelineView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/SessionQualityCard.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/StatTile.swift
  - packages/desktop/Tests/AutopodClientTests/QualityAnalyticsResponseTests.swift
does_not_touch:
  - packages/shared/src/types/profile.ts
  - packages/daemon/src/profiles/
  - packages/daemon/src/pods/state-machine.ts
  - packages/daemon/src/runtimes/
  - packages/escalation-mcp/
---

## Task

Replace the misleading single "Quality" interpretation with two honest operator
surfaces while preserving wire-route compatibility:

1. **Process Health** is the versioned per-pod trajectory signal derived from
   inspection, mutation, churn, agent tells, and genuine human-attention events.
2. **Outcome Quality** is the existing reliability/outcome evidence: first-pass
   completion, lifecycle funnel, validation-stage failures, and rework.

Introduce process-score algorithm version 3. Version 3 must stop treating
unsupported shell telemetry as evidence that an agent did not inspect code, stop
mixing outcome success into a process score, normalize file-based penalties for
task size, and prevent mixed-model attempt histories from affecting model-level
process comparisons.

Update Desktop labels and explanations so operators no longer see the process
score presented as end-result quality. Keep existing `/pods/.../quality` and
`/pods/analytics/reliability` routes and legacy JSON field names where changing
them would be a compatibility break; document legacy names as compatibility
aliases rather than silently changing their meaning.

## Motivation and evidence

A read-only investigation of the hosted database on 2026-07-30 found that
GPT-5.6 had an average persisted quality score of 51.7 despite 87.2% terminal
completion, 88.2% eventual validation pass, and 80.0% latest-review pass.
GPT-5.5 scored 70.0 while its comparable validation/review rates were 50.0% and
57.1%.

The discrepancy is traceable to telemetry shape:

- GPT-5.6 emitted 3,257 commands beginning with `/bin/bash`.
- 2,670 of 2,874 read-like GPT-5.6 commands contained syntax the current
  normalizer rejects.
- Persisted v2 scores credited only 3.4 reads against 63.7 edits per GPT-5.6 pod.
- Claude 5 cohorts also used substantially more compound shell inspection and
  were assigned much larger tasks than prior Claude cohorts.

The current implementation in `quality-score.ts` allocates half of the score to
read/edit and blind-edit proxies, but only ±5 to validation and +10 to terminal
completion. The 100-point cap allows an otherwise ideal trajectory that fails
validation to score 100. That score is useful as a process diagnostic but is not
an honest outcome-quality measure.

The investigation also found that model analytics attribute one logical-pod
score to the latest provider attempt even when retained events include several
models or runtimes. All three observed Sonnet 5 terminal pods had mixed-model
attempt histories, so those process scores cannot honestly rank Sonnet 5.

## Approved approach

### 1. Process telemetry must fail unavailable, not fail red

Extend `quality-activity.ts` with conservative support for the command envelopes
seen in current Codex traces, including `/bin/bash -lc` around an otherwise
supported read-only inspection. Support only wrappers/chains that can be parsed
without guessing repository paths. Prefer extending the existing zero-dependency
normalizer over adding a shell execution dependency.

When a command appears to contain repository inspection but cannot be safely
resolved—for example an unsupported compound shell expression—the normalizer
must report ambiguous inspection evidence. If a pod also mutates files, that
ambiguity makes inspection-dependent process scoring unavailable rather than
contributing zero reads or blind-edit penalties.

Surface an availability reason and ambiguous-inspection count in live and
persisted process-health responses. Do not expose command text or sensitive
payloads in the reason.

### 2. Process-score v3 is outcome-independent and size-normalized

Persist v3 values in new shadow columns, leaving legacy and v2 columns intact.
The rebased implementation uses `135_quality_score_v3.sql`, immediately after
Podsitter migrations 131–133 and token-telemetry repair migration 134. Do not
reuse an existing migration prefix.

The v3 score remains a 0–100 diagnostic, but contains only process dimensions:

- inspection discipline (read/edit ratio),
- blind-modification rate,
- agent stop/confusion tells,
- genuine human-attention interruptions,
- edit-churn rate.

Remove completion, validation result, killed-state, and PR-fix bonuses/penalties
from the process score. Validation and PR fixes remain visible outcome fields.
Exclude `request_credential` from human-attention interruption scoring because
credential vending can be autonomous; retain ask-human, blocker, action
approval, and validation override.

Normalize blind edits and churn by the number of distinct modified existing
files so a four-file issue in a five-file task is not equivalent to four files
in a fifty-file task. Persist/surface the modified-file denominator. Keep the
formula explicit in code comments and focused tests; do not tune it using model
names or provider-specific constants.

`validationPassed` remains a compatibility/display field but must describe the
latest validation attempt, not "any attempt ever passed."

### 3. Preserve historical truth

Set `QUALITY_SCORE_ALGORITHM_VERSION` to 3. Do not automatically rewrite v2
rows as v3 on daemon startup: retained historical traces lack parser/harness
version evidence and would create false comparability. Existing v1/v2 columns
and rows remain readable by pod ID, while v3 fleet analytics use only v3 rows.

The process-health analytics summary must disclose the active algorithm version,
legacy rows excluded from the selected window, and unavailable rows. Desktop
must render a collecting/no-comparable-data state instead of falling back to a
mixed-version average.

### 4. Make model comparison attribution-safe

A logical-pod process score may enter a model/runtime aggregate only when all
provider attempts for that pod have one distinct model and one distinct runtime.
Repeated attempts with the same model/runtime remain eligible. Mixed-model or
mixed-runtime rows are excluded from `scoredCount`, `avgQuality` (legacy wire
name), and best-process headline selection, but remain in logical outcome and
cost metrics where their established attempt attribution applies.

Raise the best-process headline threshold from 5 to 20 comparable scored pods.
Desktop low-signal messaging must use `scoredCount`, not provider-attempt
`podCount`, and visible labels must say "Process" or "Process Health," never
imply end-result quality.

### 5. Split operator semantics in Desktop

Keep internal route/card identifiers where renaming would break navigation, but
change visible language:

- Analytics `Quality` card/drill → `Process Health`.
- Analytics `Reliability` card/drill → `Outcome Quality`.
- `Session Quality` → `Session Process Health`.
- Pod score tooltip/badge → `Process health`.
- Model leaderboard/simulator `Quality` axis → `Process` or `Process Health`.
- Models summary `best:` → `best process:`.

Outcome Quality continues to show first-pass completion and the existing
funnel/stage/rework drill; do not invent a second opaque composite score.

Process-health sparklines must omit days whose `podCount` is zero rather than
plotting those days as score zero.

## Scope boundaries

### In scope

- Conservative normalization and ambiguity detection for modern shell activity.
- Process-score v3 schema, persistence, API fields, and focused migration tests.
- Latest-attempt validation semantics.
- Non-destructive v2/v3 history behavior.
- Homogeneous-attempt eligibility for model process aggregates.
- Minimum comparable-sample threshold of 20.
- Desktop terminology and no-data presentation.

### Out of scope

- A fixed paired model-evaluation task bank or hidden benchmark suite.
- A new outcome-quality composite score.
- Retrospective production-defect or user-satisfaction ingestion.
- Changes to pod lifecycle, validation gates, provider failover, runtime command
  execution, profiles, credentials, or model selection.
- Rewriting or deleting historical v1/v2 quality data.
- Renaming existing HTTP routes in a breaking way.

## Constraints and pitfalls

- The normalizer analyzes strings; it must never execute nested shell content.
- Do not count an unsupported inspection-looking command as either a successful
  read or proof that no read happened.
- Do not make all Bash use unavailable: ordinary test/build/git commands that
  contain no inspection evidence are irrelevant to inspection completeness.
- Do not silently coalesce v2 and v3 scores in trends, averages, model rankings,
  memory-effectiveness analytics, or readiness snapshots.
- Audit every consumer of `QUALITY_SCORE_ALGORITHM_VERSION`, `score_v2`, and
  `algorithm_version = 2`, including memory analytics and readiness refresh.
- Existing mixed Pi/non-Pi safeguards must remain conservative.
- A lower v3 score is not an outcome failure and must not become a validation or
  approval gate.
- Desktop is macOS-only and is not part of the pnpm workspace. Linux pod
  validation cannot substitute for local Swift/Xcode review.

## Test expectations

Add focused tests named after the contract scenarios. At minimum:

- Realistic Codex `/bin/bash -lc` simple inspection is recognized before a file
  modification.
- Unsupported compound inspection plus mutation yields unavailable process
  health with a non-sensitive reason and null score.
- The same process trajectory scores identically whether validation passes or
  fails and whether the pod completes or is killed.
- Blind/churn rates distinguish the same absolute count in small and large
  modified-file sets.
- A pass followed by a later failed validation reports `validationPassed=false`.
- New rows persist algorithm 3 fields while v2 rows survive startup history work
  unchanged and remain excluded from v3 analytics.
- Same-model retries contribute to model process aggregates; mixed-model and
  mixed-runtime attempt histories do not.
- Best-process headline selection requires 20 comparable scores.
- Quality analytics expose active version and excluded/unavailable counts.

Run the focused fact commands, relevant daemon/shared package tests, build, and
lint. On a macOS/Xcode-capable machine, run focused Swift tests plus an
`xcodebuild`/Swift build for the touched Desktop targets.

## Risks

The honest result may be fewer comparable process scores immediately after
rollout because v2 is not backfilled and ambiguous telemetry is unavailable.
That is intentional; absence is preferable to a falsely red model ranking.

Conservative shell parsing can still miss future provider trace formats. The
availability reason and algorithm version must make those failures diagnosable
without another silent score shift.

The legacy wire names `quality`, `avgQuality`, and `bestQuality` may remain for
compatibility. Review comments and user-facing text must make clear that they
carry process-health semantics in v3.

## Wrap-up

Before finishing:

1. Re-check migration numbering before writing the migration.
2. Run every required fact in `contract.yaml`.
3. Run relevant shared/daemon tests, `npx pnpm build`, and `npx pnpm lint`.
4. Run `/simplify` and address findings.
5. Commit and push; report any Desktop validation that requires macOS separately.
