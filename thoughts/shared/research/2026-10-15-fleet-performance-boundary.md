---
date: 2026-10-15T21:19:05.315625+02:00
researcher: Codex
git_commit: bafc75bf1376ffcb2d5670c626731f2334d0f3c7
branch: codex/reliability
repository: autopod
topic: "Existing pod-list performance bounds and measurement seams"
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Fleet performance boundary

research_cli mapped existing tests and sources; root verified compact projection,
route serialization/pagination, repository keyset query, DB fixture and desktop
pagination behavior. No performance measurements or optimizations were performed.

The compact route test seeds2.2million characters in task and unrelated evidence,
then asserts response below16KiB, task excerpt2000, finalization result500, no JSON
parse input above256KiB and unchanged stored result (api/routes/pods.test.ts:351).
This establishes bounded projection, not a latency distribution.

Compact SQL selects only needed fields, caps four JSON blobs at64KiB before Node,
and truncates task/title/diagnostic text (pods/compact-pod-projection.ts:14).
Completion-journal display reads are separate per-pod queries, truncating result
at500 (completion-journal.ts:19). Validating pod serialization may also read its
latest review event (api/routes/pods.ts:243). Full detail selects/parses full fields
and provider attempts; it is a separate workload.

Paged compact requests default500 rows and query limit+1, with descending
createdAt/id keyset continuation. An explicit limit above500 is rejected. An
unpaged request without limit is unbounded in row count (routes/pods.ts:630;
pod-repository.ts:685). Current pagination tests use five rows/pages of two.

Desktop DaemonAPI.listAllCompactPods sequentially fetches/decodes all pages and
checks repeated cursors (:139). PodStore maps/merges the full array on MainActor,
then loads scores (:159); hydration is cached/deduplicated. Existing native fleet
tests have no fleet-size timing assertion. createTestDb and insertTestProfile
provide disposable deterministic SQLite fixtures. In-memory SQLite is not a
cold-disk measurement; a new client is not a cold process.

Existing validation-replay benchmark demonstrates monotonic timing, priming,
alternating comparisons, fixed assertion/fixture hashes, runtime/source/host
identity and cleanup. Root read it completely. Its observations do not apply to
listing. A future plan must choose a precise boundary: repository projection,
Fastify serialized response, native decode/map, or complete store traversal.
Metrics can include rows/pages/requests/bytes, elapsed distributions and observed
memory deltas, with setup excluded and limitations explicit. No production fleet
distribution, latency target, benchmark verdict or optimization is inferred here.

## Open questions

None for current-source research. Dataset sizes, measurement protocol and regression
thresholds remain plan choices, to be fixed before any optimization.
