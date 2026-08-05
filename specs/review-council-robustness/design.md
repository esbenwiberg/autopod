# Design — Review Council Robustness and Lifecycle Presentation

## Boundaries and Brief Order

Three sequential briefs:

1. **Structured reviewer protocol and typed failures** — strict response contracts, provider integration, bounded recovery, and accurate failure classification.
2. **Canonical synthesis and lifecycle ledger** — healthy/degraded authority, first-gate provenance, canonical reconciliation, and durable fix metadata.
3. **Desktop council and fixed-finding presentation** — degraded fallback UX, typed axis labels, canonical visibility, and prominent fixed state.

Brief 02 depends on Brief 01. Brief 03 depends on Brief 02.

## Blast Radius

### Brief 01

- `packages/shared/src/types/validation.ts` — backward-compatible typed review failure and attempt metadata.
- `packages/daemon/src/validation/review-structured-output.ts` — new bounded response contracts and parsing/validation helpers.
- `packages/daemon/src/validation/review-batch-runner.ts` — validation-aware retry and typed outcomes.
- `packages/daemon/src/validation/container-reviewer-runner.ts` — optional structured-output contract on Claude/Codex container calls.
- `packages/daemon/src/validation/review-codex-runner.ts` — Codex output schema file support.
- `packages/daemon/src/runtimes/run-claude-cli.ts` only if Claude structured output requires envelope support not already present.
- Co-located tests and image/template capability tests where appropriate.

### Brief 02

- `packages/daemon/src/validation/review-synthesizer.ts` — strict exhaustive synthesis and initial-plus-structured provenance merges.
- `packages/daemon/src/validation/review-batch-runner.ts` — health calculation and synthesis recovery.
- `packages/daemon/src/validation/review-ledger.ts` — canonical source sets, raw-to-structured reconciliation, and resolution metadata.
- `packages/daemon/src/validation/local-validation-engine.ts` — canonical ledger construction and fail-closed status integration.
- `packages/shared/src/types/validation.ts` — quality, degradation reasons, and resolution metadata already introduced or completed here.
- Co-located daemon tests.

### Brief 03

- `packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift` — optional new wire fields.
- `packages/desktop/Sources/AutopodUI/Models/ReviewCouncil.swift` — healthy/degraded derivation, visible canonical/fallback collections, lifecycle sections.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ReviewCouncilView.swift` — failure copy, degraded banner, fallback section, and fixed cards.
- `packages/desktop/Tests/AutopodUITests/ReviewCouncilTests.swift` — model and historical compatibility coverage.

## Structured Output Contract

Create a single daemon-owned structured-output boundary. Zod (already available) should be the local source of runtime validation. Provider JSON Schemas must match the local contract; generate them from the same source when practical, or add contract tests that prevent drift if the pinned dependency/tooling cannot generate the provider schema safely.

Axis response shape remains conceptually:

```json
{
  "findings": [
    {
      "severity": "HIGH",
      "path": "src/a.ts",
      "line": 42,
      "symbol": "authorize",
      "claim": "specific defect",
      "evidence": "bounded source-backed evidence",
      "remediation": "bounded action",
      "confidence": 0.9
    }
  ]
}
```

Required enforcement:

- response at most 1 MB;
- at most 100 findings per axis;
- strict object shape with unknown properties rejected;
- severity enum and confidence range;
- positive integer line when present;
- bounded path, symbol, claim, evidence, and remediation;
- changed-file filtering remains mandatory after schema validation;
- IDs remain daemon-derived, never model-controlled.

The parser may normalize only transport/format wrappers: known CLI JSON envelopes, provider structured-output fields, one JSON object surrounded by harmless text, and Markdown JSON fences. It must not coerce unsupported finding fields, invent defaults for required evidence, or execute content.

## Provider Integration

`runContainerReviewer(...)` gains an optional output contract rather than becoming council-specific. Claude and Codex runners use the pinned CLI's native schema mechanism when supported. Schema material is written to a temporary file where the CLI accepts a path; otherwise it is passed as a bounded shell-quoted non-secret argument. Temporary schema, prompt, output, and log files are cleaned up.

Pinned-image tests must verify the expected flags/output envelope for the repository's Claude and Codex versions. Cached images that lack a native schema capability may use the existing prompt-constrained path, but their output still passes the identical strict local validator. Unsupported schema flags must not silently turn into a successful unvalidated review.

## Recovery and Failure Classification

Each axis gets at most two attempts, preserving the current cost bound. Attempt one uses the normal frozen prompt and structured contract. If local syntax/schema/semantic validation fails, attempt two uses the same frozen packet plus a trusted correction suffix containing only a stable validation code. Never include the malformed model output in the retry prompt.

Add backward-compatible optional failure data:

```ts
type ReviewFailureKind =
  | 'invalid-response'
  | 'timeout'
  | 'provider-unavailable'
  | 'runner-failed'
  | 'head-changed';

interface ReviewFailure {
  kind: ReviewFailureKind;
  code: string;
  message: string;
  retryable: boolean;
}
```

Retain `ReviewAxisRun.status`, numeric `attempts`, and legacy `error` so historical clients continue decoding. New clients prefer the typed failure. Diagnostics must be bounded, sanitized, operator-safe, and must not include credentials, authorization headers, prompts, diffs, or raw reviewer output.

Classification examples:

- syntax/schema/semantic contract rejected twice → `invalid-response`;
- explicit timeout error → `timeout`;
- provider authentication/outage/model unavailable → `provider-unavailable`;
- CLI/container execution failure → `runner-failed`;
- frozen reviewed HEAD changed → `head-changed`.

No failure kind can produce a completed axis or passing council.

## Healthy and Degraded Authority

Add optional batch fields:

```ts
quality?: 'healthy' | 'degraded';
degradationReasons?: string[];
```

A new batch is healthy only when:

1. all five axes completed with locally valid responses;
2. reviewed HEAD stayed equal to the frozen HEAD before every call;
3. synthesis returned a locally valid exhaustive decision set;
4. every initial finding is consumed by a merge that includes at least one structured source;
5. all canonical findings and provenance pass existing source-backed checks.

Any violation produces `degraded`, keeps the task review failed, and includes stable bounded degradation reasons. `infrastructureUnavailable` remains for wire compatibility but is no longer used as the user-facing explanation.

For historical batches without explicit `quality`, Desktop must preserve conservative legacy behavior rather than retroactively hiding evidence.

## Synthesis Rules

Synthesis remains consolidation, not a new review. It must address every candidate exactly once with known, non-reused source IDs.

A merge may include initial and structured sources when:

- at least one source is structured;
- every displayed field comes from one of the structured sources;
- the daemon derives the canonical ID after validation;
- all initial IDs remain in provenance/source IDs.

An initial finding may not be accepted as a standalone result in a healthy council. If no structured source safely represents it, the council is degraded and the raw finding remains a first-gate fallback blocker.

Synthesis itself uses the structured response boundary and one correction retry. Exhaustion produces deterministic fallback plus degraded quality; it never drops initial blockers.

## Canonical Ledger

Healthy ledger input consists of canonical accepted findings with their complete provenance source sets. It must not independently insert the same initial finding as another active record.

Degraded ledger input conservatively includes:

- valid structured findings from completed axes/synthesis fallback;
- unmatched initial first-gate fallback findings.

Reconciliation first matches exact semantic identity. It may then use unique provenance overlap to migrate one prior raw initial entry to its later canonical structured identity. Ambiguous overlap must fail closed rather than merging unrelated records.

`currentSourceIds` records all bounded canonical provenance, not only the canonical finding's own ID.

## Fixed Resolution Metadata

Add optional durable metadata to fixed ledger entries:

```ts
interface ReviewFindingResolution {
  reviewedHead: string;
  repairDiffHash?: string;
  evidence: string;
}
```

A finding becomes fixed only when closure verification completed, addressed the exact semantic ID, returned `fixed: true`, and supplied meaningful evidence present verbatim in the frozen bounded repair delta.

When a fixed finding regresses, active presentation must not retain a misleading current fixed resolution. Historical proof may remain in provenance only if modeled explicitly; otherwise clear current resolution styling/data when state becomes `regressed`.

## Desktop Presentation

### Healthy

- Show canonical structured findings only.
- Do not show `Initial Review` or first-gate fallback.
- Counts reflect the canonical lifecycle records shown by the model.

### Degraded

Show a prominent but compact banner:

```text
Council degraded — first-gate fallback findings are included.
```

Show exact typed failure copy per axis and place unmatched initial records under `First-gate fallback`, not `Initial Review`.

### Fixed

A fixed card uses:

- green check icon and prominent `FIXED` text;
- green-tinted border/background;
- historical severity wording such as `Was HIGH`, with neutral styling rather than an active red severity badge;
- visible `Verified against HEAD abc1234` when durable metadata exists;
- visible bounded closure evidence or a clearly labelled verification disclosure;
- no Dismiss action.

The All filter renders `Needs attention` first, grouped by axis, followed by a separate `Fixed in this revision (N)` disclosure collapsed by default. The dedicated Fixed filter shows complete fixed cards grouped by axis. Regressed remains a strong red active state. Rejected synthesis decisions and human-dismissed findings remain distinct from fixed.

Accessibility must communicate states with icon and text, not color alone.

## Backward Compatibility

- All new TypeScript and Swift wire fields are optional.
- No SQLite migration.
- Old batches without typed failures keep legacy error text.
- Old batches without explicit quality keep conservative legacy visibility.
- Old fixed entries without resolution metadata still receive clear fixed styling but must not claim a specific verified HEAD.
- Daemon should be deployable before Desktop because old Swift decoders ignore unknown keys.

## Observability

Log structured, sanitized fields only: pod ID, batch ID, axis, model/provider, attempt, duration, failure kind/code, and token usage. Never log raw invalid response content at normal levels. Existing retry token accounting must include all attempts.

## Validation Strategy

Daemon unit tests are authoritative for protocol, synthesis, ledger, and failure semantics. Desktop model and UI behavior requires macOS/Xcode-capable human review; Autopod-self Linux facts must not pretend to execute SwiftUI/AppKit validation.

## Reference Files

- `packages/daemon/src/validation/review-batch-runner.ts`
- `packages/daemon/src/validation/review-synthesizer.ts`
- `packages/daemon/src/validation/review-ledger.ts`
- `packages/daemon/src/validation/local-validation-engine.ts`
- `packages/daemon/src/validation/container-reviewer-runner.ts`
- `packages/daemon/src/validation/review-codex-runner.ts`
- `packages/daemon/src/validation/local-validation-engine.ts` (`parseReviewJson` provides tolerant first-gate precedent)
- `packages/shared/src/types/validation.ts`
- `packages/desktop/Sources/AutopodUI/Models/ReviewCouncil.swift`
- `packages/desktop/Sources/AutopodUI/Views/Detail/ReviewCouncilView.swift`
- `packages/desktop/Tests/AutopodUITests/ReviewCouncilTests.swift`
