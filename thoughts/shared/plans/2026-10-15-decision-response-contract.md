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
SQL already caps compact JSON at64KiB and compact summary text at240 characters.
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

- [ ] Production list/detail regression reproduces nested-envelope mismatch.
- [ ] Valid nested and legacy decisions display safely without storage mutation.
- [ ] Corruption/size bounds and healthy neighboring records remain protected.
- [ ] Same committed fixture is pinned to actual daemon output and consumed by CLI/Swift.
- [ ] Independent pre-PR, hosted and integrated proof recorded.

## Compatibility, performance and rollback

No migration, new API field, dependency or feature. Existing previously-empty
compact summaries now carry the intended bounded question/description/reason.
No unbounded additional JSON is selected. Revert display helper/serializer edits
to restore prior behavior (and the omission); fixture/tests encode the corrected
contract. Do not broaden to reply idempotency or desktop connection-scoped state.

## Status

Resolved root plan, ready for independent technical review. No open product
questions. All paths and load-bearing behavior checked against current sources;
worker must report a contradictory baseline before production changes.
