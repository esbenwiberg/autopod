# Design — Trustworthy session quality telemetry

## Blast radius

### Shared contract

- `packages/shared/src/types/pod.ts` — live and persisted quality availability/version fields.

### Runtime evidence and scoring

- `packages/daemon/src/runtimes/pi-rpc-parser.ts` — normalize documented Pi tool-execution records.
- `packages/daemon/src/pods/quality-activity.ts` — conservative inspection extraction and path canonicalization.
- `packages/daemon/src/pods/quality-signals.ts` — live counters, distinct blind files, tell provenance.
- `packages/daemon/src/pods/quality-score.ts` — availability-aware scoring.

### Persistence and API

- `packages/daemon/src/db/migrations/` — additive quality algorithm/availability columns.
- `packages/daemon/src/pods/quality-score-repository.ts` — version-aware reads and analytics.
- `packages/daemon/src/pods/quality-score-recorder.ts` — current-version writes and bounded backfill.
- `packages/daemon/src/api/routes/pods.ts` — honest quality responses.
- `packages/daemon/src/index.ts` — backfill startup wiring if needed.

### Native desktop

- `packages/desktop/Sources/AutopodClient/Types/PodQualitySignals.swift`
- `packages/desktop/Sources/AutopodClient/Types/PodQualityScore.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shared/StatTile.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shared/SessionQualityCard.swift`

## Seams

1. **Runtime event → normalized evidence** — brief 01 owns Pi RPC mapping, Codex command recognition, call correlation, and canonical paths.
2. **Normalized evidence → live quality contract** — brief 02 owns shared availability semantics, counters, grade, and score behavior.
3. **Live contract → persisted/versioned score** — brief 03 owns migration, repository, recorder/backfill, API, and analytics compatibility.
4. **API contract → desktop presentation** — brief 04 consumes availability and renders the existing tiles neutrally.

The series is sequential because each seam consumes the preceding contract.

## Contracts

### Inspection availability

Use an explicit shared representation following existing repository naming style. Inspection-dependent values must not use numeric zero to mean “unknown.” A genuine measured zero remains distinct from unavailable telemetry.

### Canonical repository path

Canonicalization strips only known workspace forms such as `./` and `/workspace/`, normalizes separators/components safely, and yields a repository-relative path. It must not equate arbitrary paths through suffix matching.

### Blind edit

Count distinct existing modified files with no earlier recognized inspection. Repeated modifications to the same unread file contribute one blind edit. New-file creation is not blind when creation evidence is trustworthy; ambiguous overwrite/create evidence lowers availability instead of asserting a false fact.

### Conservative Codex inspection

Recognize only fixture-backed content-reading forms such as `cat`, read-only `sed`, `head`, `tail`, and file-scoped `rg`. Classification parses evidence only; it never executes command text. Unknown, mutating, or ambiguous forms provide no positive read evidence.

### Pi RPC activity

Pi emits `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` with lowercase tool names and call IDs. Normalize one logical invocation once, preserve tool arguments, and correlate start/end records so quality does not double count.

### Persisted score version

Every current quality row carries an algorithm version and availability state. Analytics compare only compatible current-version scored rows, while unavailable or legacy rows remain distinguishable. Historical Codex rows may be recomputed from retained events; discarded Pi activity must remain unavailable.

### Provider continuity

Normalize each event rather than relying solely on the pod's final runtime. One logical pod remains one quality/reliability outcome even when provider attempts span runtimes.

## UX flows

Existing Work > Quality card only; no layout change.

- Available telemetry → existing numeric Read / Edit and Blind Edits tiles.
- Unavailable telemetry → `—`, neutral health, and explanatory help text.
- Persisted score unavailable → no misleading numeric score badge.

No wireframe is required because the screen and component arrangement do not change.

## Reference reading

- `AGENTS.md` — migration-prefix collision rule, testing patterns, and package architecture.
- `packages/daemon/src/pods/quality-signals.ts` — current Claude-shaped counters and tell sampling.
- `packages/daemon/src/pods/quality-score.ts` — reading/blind signals carry half of the base score.
- `packages/daemon/src/runtimes/codex-stream-parser.ts` — Codex inspections arrive as Bash while mutations arrive as file changes.
- `packages/daemon/src/runtimes/pi-rpc-parser.ts` — current lifecycle/retry handling and missing tool-execution normalization.
- `docs/decisions/ADR-033-autopod-native-pi-worker.md` — strict Pi RPC adapter and sibling-runtime contract.
- `docs/decisions/ADR-034-provider-attempt-continuity.md` — one logical pod outcome across immutable attempts.
- `docs/conventions/convention-001-autopod-self-required-facts.md` — Linux pods cannot run macOS SwiftUI/AppKit validation.
- Pi `README.md`, `docs/rpc.md`, and `docs/json.md` — authoritative lowercase tools and RPC event envelopes.

## Decisions

- ADR-033: Add Pi as an Autopod-native worker beside vendor runtimes (reused).
- ADR-034: Preserve provider continuity with immutable same-pod attempts (reused).
