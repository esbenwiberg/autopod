# R05a: preserve existing decision envelopes in list responses

## Overview and authorization

Repair the source-derived mismatch between nested escalation payloads and the
list display sanitizer/summary. Join daemon responses to CLI/Swift through one
committed fixture, following existing launch parity tests. All RPI phases, worker
execution, review and branch PR are authorized by the reliability campaign.
The Inline wireframe already shows the pending question; no new view/control or
wording design is introduced. No desktop product source change is planned.

## Current state

Research: ../research/2026-10-15-decision-response-contract.md.
EscalationRequest stores payload.question. Direct detail preserves that envelope,
but both list display paths require a top-level question and compactPod reads it.
Normal envelopes are consequently classified as invalid display shape in source.
SQL already caps compact JSON at64KiB and pending summary text at500 characters (progress text separately uses240).
Corrupt rows must remain individually diagnosed without dropping healthy pods.

## Desired result

A real pending ask-human envelope survives normal list/detail responses and
produces its question as the compact summary. Its ID/options and durable pending
ID remain intact at existing wire/DTO boundaries. Existing flattened display
question records retain their current compatibility. Known non-question payloads
are valid envelopes; display text comes only from existing question, description
or reason strings, otherwise null. No guessed decision text, schema migration,
UI-domain ID addition, reply replay or control-plane parsing change.

## Phase1: production-route regression

Use real SQLite/repositories and Fastify app.inject in existing route patterns.
Seed a synthetic awaiting_input pod with a typed EscalationRequest ask_human
(id,podId,type,timestamp,payload.question/options,response:null) and a real journal
pendingDecisionId. Stable IDs/dates are synthetic. Fetch full detail, normal list
and compact list. Assert nested identity/question/options survive full paths,
compact summary matches the question, pendingDecisionId remains non-null and no
pending_escalation invalid_shape diagnostic appears. Run before production edits
and record actual baseline failure; report mismatch if not reproduced.

## Phase2: narrow display repair

Own packages/daemon/src/pods/pod-repository.ts rowToDisplaySession and
api/routes/pods.ts compactPod. Use a small presentation-only helper in
pods/escalation-display.ts if it avoids divergent shape/summary checks.
Recognize the existing nested envelope with string id/podId/type/timestamp and an
object, non-array payload. Known display text fields (question,description,reason)
must be strings when present; do not treat a present malformed text value as safe.
Allow null/absent optional response and unknown additional fields. Preserve legacy
flat string question only when no nested payload is present. A malformed nested
payload must not silently fall back to a legacy question. Null means no decision.
This is bounded display qualification, not a new exhaustive escalation validator.

Keep other display diagnostics, strict control-plane get/update semantics, SQL
size cap and text length cap unchanged. Never rewrite stored escalation JSON as a
side effect of listing. Full envelopes/options/IDs stay intact after validation.
Compact summary chooses payload.question, then description, then reason when a
string exists, otherwise null. Legacy flat question remains a fallback only for
its legacy shape. Validation override has no invented summary. No extra payload
or params exposure in compact output.

Tests cover each current envelope type using valid typed fixtures, legacy flat,
null/absent decision, unknown extra keys, malformed nested text/payload and the
existing oversized/corrupt record cases. At least one healthy neighboring pod
must remain readable, and raw stored bytes must be unchanged. Keep assertions
focused on presentation; never let display helper results authorize transitions.

## Phase3: shared response qualification

Add packages/shared/src/fixtures/pod-decision-responses.json containing deterministic
canonical detail and compact JSON for the ask-human case, with a non-null durable
pendingDecisionId and an existing question/options. Derive it from the seeded real
route response once after the repair, then check it as committed expected data.
Document any intentionally omitted volatile/unrelated fields. The daemon test
must compare actual route output against every fixture field recursively, not
only assert that independently authored client fixtures decode. Do not change
fixture expectations to conceal a regression. It is a selected response contract,
not a new full schema generation system.

Swift test reads these same committed bytes using the existing #filePath pattern;
decode detail/compact DTOs and map them. Assert status, question/options, DTO
escalation ID and non-null finalization pendingID; assert compact and detail retain
the same question. Also qualify null finalization/optional fields and tolerated
unknown response keys without claiming UI-domain identity preservation.

CLI executable test uses the same fixture detail via the existing private loopback
harness and built `ap status <full-id> --json`; serve the optional task-execution
request explicitly (for example404), assert the request sequence, exit0, JSON
nested decision and pendingID, no fixture deadline and full teardown. A compact
list executable case proves the fixture summary survives JSON output. Production
CLI/Swift parsers and UI files remain unchanged. Source fixture paths must work
from both pnpm and Swift CI without generation or Node before Swift tests.

## Phase4: validation and independent review

Node22/pnpm9.15.4 frozen install + fresh daemon/shared/CLI builds. Run affected
repository, route, helper and real CLI tests; full daemon and CLI suites, supported
typechecks and scoped Biome/secret/diff checks. Run focused native fixture plus
existing mapper/decision/confirmed-action tests and Swift build. Hosted native CI
provides full Swift suite/Xcode checks; no need duplicate an unrelated local full
Swift suite when only a contract test changed and the affected set passes.

Before PR an independent reviewer reads final diff/fixture derivation, reruns the
production route and both consumers, and checks malformed/oversized behavior.
Target codex/reliability only; hosted checks then integrated affected rerun. No
human manual check is required for the wire/DTO contract. No native pixel/layout,
full app startup, live provider or safe reply-replay claim is made by this task.

## Acceptance

- [x] Production list/detail regression reproduces nested-envelope mismatch.
- [x] Valid nested and legacy decisions display safely without storage mutation.
- [x] Corruption/size bounds and healthy neighboring records remain protected.
- [x] Same committed fixture is pinned to actual daemon output and consumed by CLI/Swift.
- [ ] Independent pre-PR, hosted and integrated proof recorded.

## Compatibility, performance and rollback

No migration, new API field, dependency or feature. Existing previously-empty
compact summaries now carry the intended bounded question/description/reason.
No unbounded additional JSON is selected. Revert display helper/serializer edits
to restore prior behavior (and the omission); fixture/tests encode the corrected
contract. Do not broaden to reply idempotency or desktop connection-scoped state.

## Status

Implementation and local validation complete. Independent pre-PR review,
hosted checks and integration remain pending. No manual UI verification is claimed.


## Execution evidence (R05a)

- Worker branch: `codex/reliability-decision-contract`; base
  `35072a80e05a88d95391fd948b6cd9b6b11076c1`.
- Baseline route regression ran before production edits: normal list discarded the
  typed nested envelope, compact summary was null, and both added invalid_shape;
  detail and durable pendingDecisionId survived. Four failing assertions captured
  in ignored `.autopod-data/reliability/r05a/baseline.log`.
- Bounded helper now qualifies nested envelopes and legacy flat questions for
  display only. All six current escalation variants, missing/null decisions,
  unknown fields, malformed payload/text and priority/fallback rules are covered.
  Route proof includes a healthy neighbor, unchanged raw SQLite bytes, malformed
  JSON/shape diagnostics, existing64KiB selection bound and summary truncation.
- Source correction confirmed with root: pending summary already uses500 chars,
  not240 as the initial plan stated. The test now exercises600→500 truncation;
  neither existing production cap was changed.
- Fixture was captured from actual fixed detail/compact route responses using a
  temporary write in the route test, then selected into the committed JSON. That
  write was removed; the permanent test compares every committed response field
  and full nested objects. Raw capture is ignored `route-responses.json`, and the
  first fixed run is `repaired-route.log`. Fixture `_contract` documents omitted
  unrelated optional fields; no normalization or expected-value generation occurs
  during tests or native CI.
- Real built CLI tests serve these bytes from private loopback fixtures. Status
  explicitly receives404 for optional task-execution; exact requests, JSON, exit0,
  no deadline/cancellation, closed children/timers/sockets and deleted private
  directories are asserted. Compact list is a second executable case.
- Swift reads the same checked-in file with #filePath; tests DTO decision identity,
  durable pendingID, mapped question/options/status, missing/null optional fields
  and unknown response keys. No desktop production file changed.
- Frozen Node22/pnpm9.15.4 install, fresh daemon/shared/CLI dependency builds and
  supported daemon/CLI typechecks passed (`setup.log`, `build-typecheck.log`).
- Focused daemon helper/route:22 tests; built CLI fixture:2 tests (`focused.log`).
- Full CLI suite:40 files/335 tests passed (`full-tests.log`). Full daemon:391 files passed/5 skipped,6114 tests passed/10 skipped;
  no changed/new test is skipped.
- Swift affected set:40 test functions (plus parameter cases) passed, including all
  PodMapper tests, decision retention, confirmed actions/rendering and new contract
  suite. Exact generated filter is first line of `swift-affected.log`. `swift build`
  passed (`swift-build.log`). This is local Swift, not hosted Xcode qualification.
- Scoped Biome passed7 files, and diff whitespace check passed. Final repository secret scan passed after staging all new files.
  Runtime:Node22.23.3/pnpm9.15.4. Final commit identity is recorded in the ignored
  proof receipt and worker handoff (avoids a self-referencing commit hash).


Local prove-work verdict: **PROVEN** for the scoped wire/DTO contract and display
repair. The baseline and fixed route tests establish the regression; helper tests
qualify all existing payload variants; private built-process tests and Swift tests
exercise the actual client boundaries. Fixture derivation hashes and recursive
comparison receipt are in ignored `fixture-derivation.json`. No live provider,
rendered UI, reply replay, hosted checks or integration approval is inferred.

Reproduction commands, from this worktree (Node commands use
`npx -y -p node@22 -p pnpm@9.15.4 -c '<command>'`):

- `pnpm install --frozen-lockfile`
- `pnpm --filter @autopod/daemon... --filter @autopod/cli... build`
- `pnpm --filter @autopod/daemon --filter @autopod/cli typecheck`
- `pnpm --filter @autopod/daemon exec vitest run src/api/routes/pod-decision-contract.test.ts src/pods/escalation-display.test.ts`
- `pnpm --filter @autopod/cli exec vitest run src/decision-response-contract.test.ts`
- `pnpm --filter @autopod/daemon --filter @autopod/cli test`
- `pnpm exec biome check` with the7 changed TS/JSON files, and `pnpm secret-scan`.
- In packages/desktop: `swift test --filter '<filter in swift-affected.log>'`
  and `swift build`. A smaller independent fixture rerun can use
  `swift test --filter DecisionResponseContractTests`.
- `git diff --cached --check`.

Next action: freeze the clean pushed worker head for independent final review;
root owns the PR targeting codex/reliability and subsequent hosted/integrated proof.
