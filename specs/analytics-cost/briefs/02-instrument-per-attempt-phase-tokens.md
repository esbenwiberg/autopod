---
title: "Instrument per-attempt phase token writes in pod-manager"
depends_on: [01-add-pricing-module]
acceptance_criteria: []
touches:
  - packages/shared/src/types/pod.ts
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/api/
  - packages/desktop/
  - packages/shared/src/pricing/
---

## Task

Extend the `phaseTokenUsage` type to the per-attempt taxonomy from
ADR-016 and wire `pod-manager.ts` to write the new buckets.

### Type extension (`@autopod/shared`)

In `packages/shared/src/types/pod.ts`, locate the `phaseTokenUsage`
field on the pod type and the matching write path. Extend the union
to:

```ts
export type PhaseTokenUsage = Partial<Record<
  | 'agent_initial'
  | `agent_rework_${number}`
  | 'review'
  | 'plan_eval',
  { inputTokens: number; outputTokens: number }
>>;
```

The pod's `phaseTokenUsage` field should reference this exported type
rather than inlining the union — the type is consumed by Brief 03
too.

If a `PhaseTokenUsage` symbol already exists from an earlier
factoring, just widen it. If not, add it as an exported type alias and
reference it from the pod field. Don't introduce a class or
constructor — it's a structural type.

### Repository extension

In `packages/daemon/src/pods/pod-repository.ts`, lines 173-175 declare
the `PodUpdates.phaseTokenUsage` type inline:

```ts
phaseTokenUsage?: Partial<
  Record<'review' | 'plan_eval', { inputTokens: number; outputTokens: number }>
> | null;
```

Replace this with `phaseTokenUsage?: PhaseTokenUsage | null;` (importing
the new type from `@autopod/shared`). The existing `JSON.parse` /
`JSON.stringify` paths at lines 394 and 778-781 are shape-agnostic and
need no changes — JSON happily round-trips the new keys.

### Writer-side change in pod-manager

The `complete` event handler at `pod-manager.ts:4306-4321` accumulates
totals across runs. Extend it to ALSO write a per-attempt bucket
delta to `phaseTokenUsage`.

The validation-feedback loop in `processPod()` already maintains an
attempt counter (search for `validationRepo?.insert(podId, attempt,
result)` near line 6092 — that `attempt` variable is the loop
counter). Pass the counter into scope where the `complete` event is
processed, or read it from the surrounding closure.

Bucket key derivation:
- attempt counter `0` → bucket key `'agent_initial'`
- attempt counter `N >= 1` → bucket key `\`agent_rework_${N}\``

On each `complete` event:

```ts
if (event.totalInputTokens !== undefined || event.totalOutputTokens !== undefined) {
  const bucketKey = attempt === 0 ? 'agent_initial' : `agent_rework_${attempt}`;
  const existing = currentSession.phaseTokenUsage ?? {};
  const prev = existing[bucketKey] ?? { inputTokens: 0, outputTokens: 0 };
  tokenUpdates.phaseTokenUsage = {
    ...existing,
    [bucketKey]: {
      inputTokens: prev.inputTokens + (event.totalInputTokens ?? 0),
      outputTokens: prev.outputTokens + (event.totalOutputTokens ?? 0),
    },
  };
}
```

Important: `event.totalInputTokens` is the **delta for the current
agent run** (see `pod-manager.ts:4309` — it's added to the running
total). So the additive write above is correct. If a single attempt
emits multiple `complete` events (resume scenarios), the writes
accumulate into the same bucket key — which is what we want.

The `review` and `plan_eval` writers at `pod-manager.ts:6076-6088` and
`pod-manager.ts:6689-6700` are unchanged — they already write the
correct keys.

### Recovery / resume case

Pod recovery (`pod.recoveryWorktreePath` set, agent resumes via
`claude_session_id`) re-enters `processPod()` and starts a new agent
stream. The attempt counter for the resumed pod should pick up where
it left off — if the previous run was attempt 2 and validation failed,
the resumed run should bucket into `agent_rework_3`, not
`agent_initial`.

Implement: derive the starting attempt counter from
`pod.phaseTokenUsage` at the top of `processPod()` — count the
`agent_initial` (0 or 1) plus the highest `agent_rework_<N>` key. If
no buckets are present (legacy or fresh pod), start at 0.

Helper for this lives in pod-manager (new private function); don't
push it to a shared module — it's an implementation detail of the
loop.

## Touches

- `packages/shared/src/types/pod.ts` — extend `phaseTokenUsage` type.
- `packages/daemon/src/pods/pod-repository.ts` — narrow type
  reference to the new shared type.
- `packages/daemon/src/pods/pod-manager.ts` — per-attempt write at
  the `complete` handler; recovery-aware attempt-counter derivation.
- `packages/daemon/src/pods/pod-manager.test.ts` — new test cases
  (see Test expectations).

## Does not touch

- `packages/daemon/src/db/migrations/` — no migration needed; the
  column is already TEXT JSON and new keys are additive (ADR-016).
- `packages/daemon/src/api/` — endpoint work is Brief 03.
- `packages/desktop/` — UI work is Brief 04.
- `packages/shared/src/pricing/` — Brief 02 doesn't compute costs.
  Costing happens at read time in Brief 03.

## Constraints

From ADR-016: keys are open-ended (`agent_rework_${number}` template
literal). Anything that *reads* `phaseTokenUsage` must tolerate
unknown rework keys gracefully. Brief 03 does the reading; Brief 02
just writes.

From `design.md` → Reference reading: `pod-manager.ts:4306-4321` is
the exact insertion point. Don't refactor the surrounding code; the
file is large and the reviewer needs a tight diff to follow the
change.

From `purpose.md` → Reversibility: the writer is additive; reverting
this brief stops new writes but leaves existing writes in place. No
migration to roll back. Make sure the recovery-case attempt-counter
derivation also tolerates the *absence* of any buckets (treat as
attempt 0) — this is what makes pre-Phase-1 pods resumable.

## Test expectations

Add to `packages/daemon/src/pods/pod-manager.test.ts`:

- **Initial run writes `agent_initial`.** A pod with no prior
  `phaseTokenUsage` runs once, emits one `complete` event with
  `totalInputTokens: 1000`, `totalOutputTokens: 500`. After: pod's
  `phaseTokenUsage.agent_initial` equals `{ inputTokens: 1000,
  outputTokens: 500 }`.
- **One rework writes `agent_rework_1`.** Same pod fails validation
  once, retries, emits a second `complete` event with token counts
  `300/200`. After: `phaseTokenUsage.agent_rework_1` equals
  `{ inputTokens: 300, outputTokens: 200 }`. `agent_initial` is
  unchanged.
- **Multiple `complete` events in one attempt accumulate.** A single
  attempt emits two `complete` events (resume mid-attempt). Writes
  accumulate into the same bucket.
- **Existing `review` writes still work.** Confirm the existing
  review-token write at line 6076 still lands under
  `phaseTokenUsage.review` and doesn't trample agent buckets.
- **Recovery-case attempt counter.** A pod entering `processPod()`
  with `phaseTokenUsage = { agent_initial: ..., agent_rework_2: ... }`
  starts the next agent stream's writes into `agent_rework_3`, not
  `agent_initial` and not `agent_rework_1`.
- **Empty / null phaseTokenUsage starts at 0.** A pod with `null`
  `phaseTokenUsage` enters `processPod()` and starts at attempt 0.

Use `createTestDb()` and the existing pod-manager test scaffolding.
Mock the runtime to emit canned events; the new behaviour can be
exercised without spinning up a container.

## Risks / pitfalls

- **Attempt counter scoping** — pod-manager.ts is large and has many
  closures. The attempt counter currently lives in the validation-loop
  scope; the `complete` handler is in an event-stream consumer scope
  that may be a few function calls away. If the natural reach is
  awkward, lift the counter to a `let` declared just above the event
  loop and update it in lockstep with `validationRepo.insert()` calls.
  Don't pass it through a long parameter chain.
- **Resume mid-attempt double-write** — if a resume re-emits the same
  `complete` event the first run already produced, the bucket would
  double-count. Verify behaviour against the existing
  token-accumulation test at `pod-manager.test.ts:1960` ("accumulates
  costUsd across multiple runs instead of replacing") — that test
  already pins the behaviour we want to mirror. The runtime is
  expected to emit one `complete` per run; if it emits more, the
  existing total is also wrong. Don't try to deduplicate here.
- **Open-ended `agent_rework_<N>` keys** — `Object.keys()` ordering
  is insertion order in modern V8 but not guaranteed for JSON
  round-trips. Brief 03's aggregator must sort numerically; don't
  rely on insertion order at the writer side.
- **Type-check fallout** — extending the union may surface call-sites
  outside the touched files that destructure the old shape. Let the
  TypeScript compiler drive the migration; do NOT add a `default`
  case to silence missing-case warnings.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm build` — must pass (transitive type-check across
   shared → daemon).
3. `npx pnpm --filter @autopod/daemon test` — must pass.
4. Commit and push.
