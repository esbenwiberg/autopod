# Checkpoint 1: settlement and evidence foundations

Goal remains active. All six workstreams remain in scope. This is partial implementation, not closure.

Implemented: late summaries allowed while human input remains pending; completion refuses to validate/deliver through a pending question; SQLite settlement/decision journal with generation guards; local/sandbox restart keeps unanswered input actionable; cost projection avoids large unrelated JSON; operator list reads diagnose malformed rows while control-plane getters fail closed; executed coverage and first-pass denominators corrected; attempts, distinct pods and recorded PR deliveries separated; shared PRs deduplicated, with earlier-window deliveries excluded. CLI/mobile/desktop expose settlement and evidence gaps; desktop analytics uses the delivery denominator. Claude structured 529 is provider unavailable, never authorization for account failover.

Proof: baseline source diagnostics failed five desired behaviors and retained the correct state guard. Real manager/bridge settlement tests first failed, then passed. Schema 139 and 141 upgrades and database close/reopen pass. Targeted tests, workspace build and Swift decoding/mapping/simulator receipts are in receipts/. These are local tests with mocked external boundaries, not live delivery or operator interaction acceptance.

Current live read-only evidence: remote main is 2d5456edac542a99d27f12eb1dbd16e5ad8c2c2a; health says schema 139, 4 containers, no queued/active sessions; release SHA unavailable. History pages 10 and 100 pass; cost remains HTTP 500. Azure Run Command read-only inspection is still outstanding (session 29869); do not launch a second Run Command while it may remain active. Do not claim malformed JSON as production diagnosis. No production mutation, paid canary, push, PR or deployment was authorized or performed.

Next unfinished criteria: complete delivery intent/reconciliation and concurrent finalization guarantees; exact dispatch preflight; task-wide retry/budget and validation identity/cache; real scheduled deterministic scanning/triage; provenance and backup scope/restore; all operator interactions; full pipeline and matched benchmark. Cost projection and list diagnostics are separate from proving the live API root cause. Compact list projection still needs tighter payload bounding. No complete goal or workstream claim.

Migration numbering: inspected 262 local/remote refs; maximum 141 and no existing 142. Added 142. Preserve all older fetch/review/provider/deployment fixes.

## Verification receipts before checkpoint commit
- 389 tests passed in the combined targeted run; four newly added sandbox cases initially had a missing test logger. The corrected focused suites passed 107 tests, including all four cases and the new malformed-record API route test.
- Workspace build passed seven tasks. Desktop decoding/mapping/analytics passed 64 tests. Lint passes.
- These receipts precede the checkpoint commit. Full required pipeline and final exact-commit validation are still outstanding.
