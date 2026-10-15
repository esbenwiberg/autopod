# R08b: reproducible compact fleet-list qualification

## Scope and authorization

The reliability campaign authorizes research, resolved technical planning and
worker implementation. Research is `../research/2026-10-15-fleet-performance-boundary.md`.
Measure the current real SQLite -> repository -> Fastify compact paginated list
boundary, with deterministic correctness assertions. This task does not optimize
production code, choose a product latency SLA, or claim native UI performance.
Root owns the plan; independent review precedes PR and campaign integration.

## Current source

`compact-pod-projection.ts` bounds selected JSON and task text before Node.
`podRoutes` accepts `/pods?compact=true&page=true&limit=500` and returns pods plus
nextCursor. `createPodRepository` supplies the real paginated projection and
completion-journal reads. Existing `pod-decision-contract.test.ts` demonstrates a
minimal Fastify registration using real SQLite/repository plus a manager facade.
The existing single-row large-payload test bounds bytes, not fleet traversal time.
`createTestDb` provides an in-memory migrated schema; it depends on Vitest.
The repository's existing benchmark pattern records source/runtime/fixture identity.

## Phase 1: isolated benchmark and structural checks

Add an opt-in Vitest qualification under `scripts/benchmarks/` and its explicit
config. No production or ordinary CI workload changes, no new dependency. The
benchmark filename must not match the default test glob. Invoke from repository
root using the explicit config; require an explicit environment opt-in and fail
with a useful command if absent. Force a single worker, no concurrent datasets.
Keep run output under ignored `.autopod-data/reliability/r08b/`, never source paths.

Use production podRoutes, real createPodRepository and createTestDb. A narrow
manager facade may expose repository methods like the existing contract test;
no mocked list/project/serialization implementation. Register no provider/network
side effects and make no external requests. Close Fastify and SQLite in finally.
Any local temporary files must be owned and removed on success/failure.

Fixed datasets:100,1000,10000 pods, page size500. Each uses synthetic IDs and dates,
with groups sharing createdAt to exercise the ID tie-breaker. Cycle statuses
running, paused, awaiting_input and complete; no validating/review-event workload
is claimed. Use a4096-character synthetic task per row, a well-formed question for
awaiting_input, and a real finalization row for every pod with deterministic
pending IDs where applicable. Every100th pod also contains64KiB of unrelated
validation evidence; one row contains2MiB of unrelated evidence. Record exact
field sizes, row counts, generated manifest hash and database page_count/page_size.
Use transaction seeding and production insert where practical. Setup is untimed.
Avoid generating huge aggregate JSON solely to hash fixtures: hash deterministic
input metadata plus streamed rows or their independently reproducible identifiers.

Before timing, traverse each dataset and assert exact descending createdAt/id
order; every expected ID exactly once; no unknown IDs; total count; page count
ceil(N/500); maximum500 records; no repeated cursor; final cursor null;200 status;
bounded task excerpts and valid question/finalization summary; unrelated evidence
absent from responses. Compare first and last tied-date groups explicitly. These
checks must fail if a page repeats, drops, duplicates or reorders a record.
Do not silently continue after a correctness failure or empty benchmark selection.

## Phase 2: measurement and evidence

One untimed full traversal primes each dataset. Then seven measured traversals
per dataset, in rotating size order across rounds so one size is not always
measured last. Fixed seeds and identical assertions in all runs. Use monotonic
performance.now. Record per-page request+JSON-decode duration, first-page duration,
full-traversal duration (all requests/decodes/cursor bookkeeping), page counts and
serialized byte totals. Run correctness comparisons outside the measured traversal
window. Record raw samples plus min/median/p95/max; label seven-sample traversal
p95 as descriptive (effectively max), not a statistically established tail SLA.

Sample process.memoryUsage before traversal and after every page; report observed
RSS/heap sample maxima and deltas. Clearly label these sampled process values,
not true allocation peaks, retained-memory/leak proof or production memory budgets.
Do not force GC or subtract unrelated fixture memory to invent an allocation result.
Record runtime versions, OS/architecture/CPU model, source HEAD, dirty status,
relevant source/config/lockfile hashes, generated fixture manifest hash, start/end
times, exact command and warm in-memory scope. Unrelated concurrent host work is
uncontrolled; no precise cross-machine comparison or cold-disk/network/native
rendering claim. A single explicit bounded command should reproduce the run.

Success is correct full traversal plus complete honest measurements. No arbitrary
latency threshold, assertion that current performance is acceptable, or speculative
optimization. A later change can use this frozen protocol for before/after work.
Inspect results for growth and anomalous samples; document observations without
assuming causation. Never hide slow/error samples by rerunning until green.

## Phase 3: independent proof and integration

Worker executes the complete protocol once under Node22/pnpm9.15.4, supported
TypeScript/static checks for new files, scoped Biome, whitespace and secret scan.
Add small deterministic tests for any nontrivial report/statistics helpers only
where they protect evidence correctness; avoid implementation-mirroring tests.
An independent reviewer inspects fixture fidelity, timing boundary, ordering and
cleanup, then reruns the exact protocol once at the frozen final head. Preserve
both reports; observed timing differences are not a regression verdict without
controlled before/after conditions. Open PR only after independent review.
Hosted checks then integrated benchmark correctness/config checks. If benchmark
and relevant product hashes are unchanged, do not duplicate all21 measurements
solely because of a merge commit. No human visual/manual check is required.

## Acceptance

- [ ] Real route traverses all three deterministic datasets correctly.
- [ ] Seven raw measurements per size and identity/memory/bytes metadata retained.
- [ ] Timing and fixture limitations explicitly reported; no unearned speed claim.
- [ ] Independent pre-PR reproduction, hosted and integrated checks recorded.

## Compatibility and rollback

Only opt-in qualification scripts and evidence documentation. No schema, API,
UI, runtime dependencies or automatic benchmark CI. Remove the scripts to revert.
This covers warm in-memory paged route traversal; unpaged listing, real disk,
concurrent fleet mutation, validation-event queries, HTTP transport, Swift decode,
MainActor merge and visible rendering remain separate workloads.

## Status

Root resolved technical plan under standing campaign authorization, awaiting
independent plan review before delegation. No unresolved product choices.
