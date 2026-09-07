# Checkpoint 11: atomic decisions and changed production baseline

Starting commit: 776724bfb1d11bc33c97081201654e14befc1f4e. Changes remain on the isolated local branch.

Fault injection reproduced separate escalation-row/pod-state writes and separate reply-receipt/state writes. A synchronous SQLite unit of work now defers status publication until the outer commit and discards rolled-back notifications. The escalation coordinator owns atomic question creation for MCP, host fetch/push credentials, and validation overrides, plus normal completion replies. A failed transition leaves neither an orphan row nor a changed response. Nested transactions and rejected asynchronous callbacks are covered.

Further desired-behavior failures reproduced a second unanswered question being stored without an actionable pod attachment, and duplicate replies replacing the escalation responder while the completion decision retained the first actor. Creation now preserves one actionable question, treats the exact repeated ID/content as idempotent, rejects conflicting content or overlapping unanswered questions, and refuses an attachment that did not result in awaiting_input. The journal preserves the first reply actor/time. Existing transition guards remain intact.

Final affected suites passed 528 tests across eight files, including actual manager, both end-to-end suites, bridge behavior and disk-reopened completion journal. All package builds passed. Broad existing direct daemon tsc failures remain; this is not a full pipeline pass. Creation and normal replies are atomic, but credential/action/override response dispatch, previously orphaned decisions, reply-delivery recovery and push/merge/cleanup side effects remain outstanding.

## Production refresh and migration conflict

The refreshed public health/compact-history/cost endpoints returned 200. Health reports 148 applied migration records, not schema version 148. This task did not deploy or restart production. Fresh origin/main remains 2d5456edac542a99d27f12eb1dbd16e5ad8c2c2a with migrations through 141.

Read-only coordination with the existing task titled Implement AutoPod Dispatcher phases identified separate authorized maintenance and managed-schema deployment. Its local recovery record reports database MAX(version)=150, native release /opt/autopod/releases/0674b95f, expanded persistent disk, and native startup reconciliation changing the two previously outstanding pods to failed. Those are dated evidence from that task, not a new direct VM verification by this task. No authority from its maintenance scope is imported here.

Its owned producer worktree contains managed migrations 142–150, conflicting with our unpublished 142–149. Our previous checks against Git refs could not see those untracked files. Before any release candidate, renumber this branch's changes after the deployed managed schema and verify combined upgrade compatibility. Preserve the managed implementation; do not enable it or copy its execution authority. Do not infer a cost-API root cause merely because it now succeeds after maintenance.

The original Run Command inspection failed on extension storage. A new read-only SSH/sudo metadata inspection was rejected by automatic approval review: production metadata egress required payload-specific approval. No SSH inspection ran. A concrete syntax-checked script and exact approval question are pending. Continue all local work while waiting. No goal completion is claimed.
