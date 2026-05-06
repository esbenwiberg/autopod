# ADR-016: Per-attempt phase token taxonomy

## Status
Accepted

## Context

`pods.phase_token_usage` (migration `089`) was introduced as a
`Partial<Record<'review' | 'plan_eval', { inputTokens, outputTokens }>>`.
It captures token counts for the AI task review pass and the
plan-evaluation pass, but the agent's own work is **not phase-tagged** —
all of it lands in `pod.inputTokens` / `pod.outputTokens` as a single
opaque total.

Phase 1 of the analytics dashboard wants a per-phase stacked bar in the
Cost drill-in that answers "where in the pod lifecycle is the money
going?" The current shape can't answer that for the agent itself —
which is the dominant cost.

The pod's validation-feedback loop in
`packages/daemon/src/pods/pod-manager.ts` is the natural seam: each
loop iteration is one agent stream that ends in a `complete` event
carrying that iteration's delta tokens
(`pod-manager.ts:4306-4321`). We can attribute each `complete` event
to a known attempt counter and store per-attempt deltas without
needing any change to the runtime stream parsers.

Three taxonomies were considered (see Phase 1 planning interview):
per-attempt, per-rework-reason, and coarse 3-bucket. Per-rework-reason
is more diagnostic but requires pod-manager to remember why each
rework started; coarse 3-bucket reduces to what we already have plus
the writer's existing review/plan_eval split. Per-attempt is the
sweet spot — it captures *where rework cycles eat money*, which is
the operator's most actionable question, without adding state to the
validation loop beyond an attempt counter that already exists.

## Decision

Extend `phaseTokenUsage` to carry these keys:

```ts
type PhaseTokenUsage = Partial<Record<
  | 'agent_initial'
  | `agent_rework_${number}`  // 'agent_rework_1', 'agent_rework_2', ...
  | 'review'
  | 'plan_eval',
  { inputTokens: number; outputTokens: number }
>>;
```

Writer placement: the existing `complete`-event handler in
`pod-manager.ts:4306-4321` snapshots the in-flight attempt counter
when accumulating tokens and writes the delta into the matching
bucket (`agent_initial` for attempt 0, `agent_rework_<N>` for attempt
N where N ≥ 1). `review` and `plan_eval` continue to be written as
they are today — no change there.

Schema change: **none**. The column is already `TEXT NULL` JSON
(migration `089`); new keys are additive at the application layer.
No migration is needed. Existing rows show `null` or the old shape,
and the reader treats missing keys as `{ inputTokens: 0, outputTokens: 0 }`.

Forward-only: pods that completed before Phase 1 ships have no
per-attempt data. The cost endpoint groups them under an
`agent_legacy` synthetic bucket (computed at aggregation time from
`pod.inputTokens - sum(known buckets)`), so historical totals still
reconcile.

## Consequences

Easier:
- Per-phase stacked bar has real data going forward.
- Rework-cycle cost becomes visible — direct answer to "did this PR
  cost 3× because we kept rebuilding?".
- No DB migration; the writer change ships in one brief.

Harder:
- The bucket key shape (`agent_rework_${N}`) is now a contract.
  Anything that reads `phase_token_usage` (today: just the cost
  aggregation, plus existing review/plan_eval reads) must tolerate
  the open-ended set of `agent_rework_*` keys. Document this on
  the type.
- The reader must reconstruct `agent_legacy` for old rows. Mild
  complexity in the aggregation layer.
- A pod that retries 50 times produces 50 bucket keys. JSON size is
  still tiny, but the per-phase bar UI must collapse high-N reworks
  into "+ N more reworks" rather than rendering 50 stack segments.

Committed to:
- The four bucket families: `agent_initial`, `agent_rework_<N>`,
  `review`, `plan_eval`. Adding a new family is a follow-up ADR.
- Forward-only data; no backfill of pre-instrumentation pods.
