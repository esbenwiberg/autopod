# Handover — perfect-boa (Brief 02: Instrumentation Seam)

## What was built

Extended `phaseTokenUsage` to the full per-attempt taxonomy and wired
`pod-manager.ts` to write per-attempt token buckets.

**Files changed:**

- `packages/shared/src/types/pod.ts` — added exported `PhaseTokenUsage`
  type alias with `agent_initial`, `` `agent_rework_${number}` ``,
  `review`, and `plan_eval` keys. Updated `Pod.phaseTokenUsage` to
  reference it instead of inlining the narrower type.
- `packages/shared/src/index.ts` — added `PhaseTokenUsage` to pod
  re-exports.
- `packages/daemon/src/pods/pod-repository.ts` — replaced the inline
  `PodUpdates.phaseTokenUsage` type with `PhaseTokenUsage | null`
  (imported from `@autopod/shared`).
- `packages/daemon/src/pods/pod-manager.ts` — added
  `deriveAgentAttempt()` private helper, added `attempt` parameter
  (default 0) to `consumeAgentEvents()`, wrote per-attempt bucket
  delta in the `complete` event handler, and updated all call sites.
- `packages/daemon/src/pods/pod-manager.test.ts` — 6 new test cases
  in `describe('phaseTokenUsage per-attempt bucket writes')`.

## Deviations from brief

- **Call sites for sendMessage and rejectSession:** The brief said to
  pass the `attempt` variable from `triggerValidation` to all call
  sites. Since `consumeAgentEvents` is a public method called from
  multiple contexts, I added `attempt` as an optional parameter
  (default 0):
  - `processPod()` (line 4253): passes `startingAttempt` derived from
    `deriveAgentAttempt(pod.phaseTokenUsage)` — handles recovery case.
  - `triggerValidation()` (line 6682): passes local `attempt` variable
    directly — handles the validation-failure retry.
  - `sendMessage()` guidance resume (line 4954): passes
    `pod.validationAttempts` — equivalent to the local `attempt` at
    that point since validationAttempts was already set by triggerValidation.
  - `sendMessage()` human message resume (line 4995): passes
    `pod.validationAttempts` (0 if pre-validation, correct).
  - `rejectSession()` (line 5441): passes
    `deriveAgentAttempt(pod.phaseTokenUsage)` — necessary because
    `validationAttempts` is reset to 0 before this call, but
    `phaseTokenUsage` still reflects prior history.

## Interfaces and contracts Brief 03 must know

### `PhaseTokenUsage` type

```ts
export type PhaseTokenUsage = Partial<Record<
  | 'agent_initial'
  | `agent_rework_${number}`
  | 'review'
  | 'plan_eval',
  { inputTokens: number; outputTokens: number }
>>;
```

Exported from `@autopod/shared` — Brief 03 can import it directly.

### Writer semantics

- `agent_initial`: tokens from the pod's first agent run (attempt 0
  in `consumeAgentEvents`).
- `agent_rework_N` (N ≥ 1): tokens from the Nth validation-failure
  retry. Matches the `attempt` counter in `triggerValidation` (which
  starts at 1 for the first retry).
- Multiple `complete` events in the same attempt accumulate (additive
  merge into the bucket).
- `review` and `plan_eval` are written by `triggerValidation` and
  `revalidateSession` — unchanged.

### `agent_legacy` reconstruction (Brief 03 reads)

For pods that completed before Phase 1, `phaseTokenUsage` will be
null or have only `review` / `plan_eval` keys (no agent buckets). The
aggregator must reconstruct an `agent_legacy` synthetic bucket for
these pods — Brief 03 owns that logic. The writer here makes no
attempt to backfill.

### `deriveAgentAttempt(phaseTokenUsage)` semantics

Returns the *next* attempt to write to:
- 0 when no `agent_initial` key is present (fresh or legacy pod)
- 1 + highest rework N if `agent_initial` + `agent_rework_N` keys
  are present

Brief 03 may find this useful for reading the "how many times did
the agent retry?" question: `Object.keys(phaseTokenUsage).filter(k =>
k.startsWith('agent_rework_')).length`.

## Files Brief 03 must NOT modify without good reason

- `packages/shared/src/types/pod.ts` — type is stable; Brief 03
  only reads it.
- `packages/shared/src/pricing/` — unchanged from Brief 01;
  Brief 03 reads these files.
- `packages/daemon/src/pods/pod-manager.ts` — the writer-side change
  is done; Brief 03 adds a new route file and does not touch the
  manager.

## Constraints and landmines

- **`agent_rework_${number}` key ordering**: Object.keys() iteration
  order is insertion order in V8 but NOT guaranteed after JSON
  round-trips. Brief 03's aggregator must sort rework keys
  numerically, not rely on insertion order.
- **Pre-Phase-1 pods**: pods with null or empty `phaseTokenUsage`
  will have no agent buckets. The aggregator must handle this via the
  `agent_legacy` reconstruction per ADR-016.
- **TypeScript template literal types**: `agent_rework_${number}` is
  a TypeScript template literal type. When writing keys, the
  `attempt` parameter must be cast: `` `agent_rework_${attempt}` as
  `agent_rework_${number}` ``. When reading (Brief 03), iterate
  `Object.keys()` and filter/match with `/^agent_rework_(\d+)$/`.
- **No migration needed**: `phaseTokenUsage` is stored in the existing
  TEXT JSON column. New keys are additive and transparent to the
  existing JSON.parse/JSON.stringify path.
