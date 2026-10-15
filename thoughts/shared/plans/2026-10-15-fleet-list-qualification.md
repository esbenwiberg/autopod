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

Add an opt-in `.bench.mjs` Vitest qualification under `scripts/benchmarks/`
and an explicit `.config.mjs` config. Use plain JavaScript with runtime assertions
and `node --check`/Biome; do not claim daemon TypeScript covers these files. No production or ordinary CI workload changes, no new dependency. The
benchmark filename must not match the default test glob. Invoke from repository
root using the explicit config; require an explicit environment opt-in and fail
with a useful command if absent. Force a single worker, no concurrent datasets.
Keep run output under ignored `.autopod-data/reliability/r08b/`, never source paths.

Use production podRoutes, real createPodRepository and createTestDb. A narrow
manager facade may expose repository methods like the existing contract test;
no mocked list/project/serialization implementation. Register no provider/network
side effects and make no external requests. Resolve Fastify with createRequire anchored to packages/daemon/package.json,
using its installed dependency, with no new root dependency. Close Fastify and
SQLite in nested finally blocks, so failed app closure cannot skip DB closure.
Any local temporary files must be owned and removed on success/failure.

Fixed datasets:100,1000,10000 pods, page size500. Each uses synthetic IDs and dates,
with groups of37 sharing createdAt so ties cross the500-record page boundary
in the1000 and10000 datasets. Use ASCII fixed-width IDs and SQLite-compatible
lexical ordering to exercise the ID tie-breaker. Cycle statuses
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
Within every traversal, cap requests at ceil(N/500) and fail immediately if a
non-null cursor would require more. This safety bookkeeping is timed consistently;
it prevents broken pagination from hanging before post-run checks. Set a120-second
whole-test timeout. Do not silently continue after a correctness failure or empty
benchmark selection.

## Phase 2: measurement and evidence

Keep all three fixture databases resident for the complete run and explicitly
report that condition. One untimed full traversal primes each dataset. Then seven measured traversals
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

The exact reproduction command must first freshly build @autopod/shared and
record hashes of its actually loaded dist output; direct Vitest bypasses daemon
pretest. Worker executes the complete protocol once under Node22/pnpm9.15.4,
node --check on both new MJS files, scoped Biome, whitespace and secret scan.
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

- [x] Real route traverses all three deterministic datasets correctly.
- [x] Seven raw measurements per size and identity/memory/bytes metadata retained.
- [x] Timing and fixture limitations explicitly reported; no unearned speed claim.
- [x] Independent pre-PR reproduction, hosted and integrated checks recorded.

## Compatibility and rollback

Only opt-in qualification scripts and evidence documentation. No schema, API,
UI, runtime dependencies or automatic benchmark CI. Remove the scripts to revert.
This covers warm in-memory paged route traversal; unpaged listing, real disk,
concurrent fleet mutation, validation-event queries, HTTP transport, Swift decode,
MainActor merge and visible rendering remain separate workloads.

## Status

Independent plan review by research_desktop resolved four source-backed gaps:
ties must cross page boundaries, traversal needs its own hard page cap, root
Fastify resolution/static coverage must be explicit, and loaded shared output
must be freshly built and hashed. Root incorporated those corrections plus
resident-database accounting and nested cleanup. Resolved under standing campaign
authorization; ready for implementation. No unresolved product choices.

## Implementation progress

The opt-in harness and explicit config are implemented under `scripts/benchmarks`.
A separate protocol module checks the complete independent expected order and
summary fields after timing; its two checks inject repeated/dropped/duplicated/
reordered pages and verify descriptive statistics. The timed loop retains raw and
decoded pages until verification, and includes byte/cursor bookkeeping and sampled
memory calls; per-page timings cover injection plus JSON decoding only. Partial
raw samples are preserved if correctness or the page cap fails.

Frozen Node 22 / pnpm 9.15.4 install completed without lockfile changes. MJS syntax
and scoped Biome checks passed. Protocol checks: two passed; benchmark explicitly
filtered out. The explicit config without opt-in failed as intended before DB
creation; empty file selection also exited 1. Ordinary Vitest discovery selected
no files under `scripts/benchmarks`. Logs are in ignored
`.autopod-data/reliability/r08b/`. The first complete qualification results follow below.

Reproduce from repository root after frozen install:

```bash
npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm --filter @autopod/shared build && AUTOPOD_FLEET_BENCHMARK=1 pnpm exec vitest run --config scripts/benchmarks/fleet-list.config.mjs'
```

## Worker qualification result

PROVEN for this bounded warm in-memory route qualification. The exact reproduction
command above completed once on clean implementation commit
`1581c68c10100547247d524b1cda5558ebb5f0bf`, using Node 22.23.3, pnpm 9.15.4,
Vitest 4.1.11, Fastify 5.12.5 and better-sqlite3 11.10.0. All three priming traversals
and all 21 measured traversals passed every ordering/field assertion; the two
protocol checks passed too (three Vitest tests total). All three DBs closed,
with zero cleanup errors. No failed full measurement runs were discarded.

Receipt: `.autopod-data/reliability/r08b/fleet-1581c68c1010-1792093047010.json`;
command/build output: `qualification.log` alongside it. The receipt contains raw
per-page/traversal timing, process-memory samples, bytes, fixture hashes, database
page counts/sizes, host/runtime identity, source hashes and freshly built shared
dist hashes. The subsequent commit changes this evidence documentation only;
benchmark/product hashes remain the qualification target.

| Pods | Pages | Traversal min / median / max ms | First-page median ms | Serialized bytes |
| --- | --- | --- | --- | --- |
| 100 | 1 | 2.804 / 3.008 / 9.806 | 2.976 | 355553 |
| 1000 | 2 | 27.929 / 29.866 / 30.687 | 15.577 | 3555384 |
| 10000 | 20 | 621.705 / 638.411 / 664.028 | 44.510 | 35554542 |

Each row has seven raw samples; nearest-rank traversal p95 equals that row's max.
The 100-pod 9.806 ms sample is retained, not rerun away. The 10000-pod median is about
21.4 times the 1000-pod median for 10 times as many rows. This is an observation,
not a diagnosis of query complexity or an optimization claim. Byte totals were
identical across the seven traversals of each dataset.

The largest sampled process RSS was 1405632512 bytes and heapUsed 460906104 bytes.
These include Vitest, all three resident databases, fixture expectations, raw and
decoded response retention, and other process state. They are not isolated route
allocations, true peaks, leak proof, or production memory requirements. Measurements
exclude source hashing/setup and post-traversal correctness comparisons; traversal
timings include the documented per-page sampling and safety bookkeeping. Host
contention remains uncontrolled. No product latency or native/UI claim follows.

Static checks: `node --check` on all four MJS files, scoped `pnpm exec biome check
scripts/benchmarks`, secret scan, and diff whitespace checks all exited 0. Logs:
`static.log`, `secret-scan.log`, `diff-check.log`. Explicit opt-in absence and
missing-file selection exited 1 as intended (`opt-in-required.log`,
`empty-selection.log`); default Vitest file listing selected no benchmark files
(`default-discovery.log`). Independent review/reproduction, hosted checks and
integrated verification remain root-owned and unchecked. No human manual check
is required for this nonvisual task.

## Coordinator integration proof

Root independently read all four qualification files and reproduced all21 measurements at final1e179dc1. Hosted general/secret checks passed (run38796536758). After campaign merge04dabd6a, both deterministic protocol checks passed; benchmark and relevant daemon/shared source and lock hashes are unchanged, so all21 measurements were not repeated solely for the merge. Worker and root raw receipts remain under ignored r08b/. No production latency or memory budget is asserted.

Integrated commands and results: `.autopod-data/reliability/qualification-integrated.log`. PR #428 targets the campaign branch.
