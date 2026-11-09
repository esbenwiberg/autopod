# Scoped Claude session telemetry reconciliation

This operator control repairs accounting only. It never resumes a worker, passes a
check, publishes source, increases a budget or replaces an unknown worker result.

Authenticated **pod owner or admin/operator** endpoints:
- GET /pods/:podId/claude-telemetry: read-only exact-session preview or stored receipt.
- POST /pods/:podId/claude-telemetry: strict body
  {"expectedBinding":"<preview SHA256>","reason":"<10–4000 characters>"}.

The pod creator's exact authenticated subject (`oid` = stored `pod.userId`) may
preview and apply without an Entra app role. Admin/operator access remains
supported. A connected UI, matching email, another account for the same person,
or caller-supplied identity/roles does not establish ownership. Authorization is
checked before reading stored receipts and rechecked after asynchronous evidence
observation and inside the apply transaction. The immutable receipt records the
actor, ownership basis and original owner. The fleet-wide
`/admin/token-telemetry/repair` endpoint remains admin/operator-only.

Save preview, exact request and response before proceeding. On a lost response,
inspect GET; never change a request to bypass an uncertain admission. The same
binding/reason/actor returns the existing receipt; conflicts refuse.

## Supported evidence

Only a failed frozen local Claude pod with exactly one positively settled retained
Docker worker and one untouched zero-usage, still-open provider segment is eligible.
The native session IDs, model, account, run, lifecycle generation, exact Docker
namespace/resource and stopped status must agree. All execution/control ownership
ledgers must be settled. Other segment shapes and unresolved execution fail closed.

The daemon reads only its exact durable per-pod Claude project session, not a
caller-supplied path or usage. Symlinked paths, multiple matches, oversized or
changing files, malformed rows and conflicting response IDs are refused. Repeated
assistant blocks for one API response count once. Direct input, cache-read input
and cache-creation input all contribute to cumulative input; thinking already
included in output is not counted twice. Per-response sums must agree with a
single final native cost-state for the exact session/model. The runtime cost is an
**estimate**, not proof of billing.

Apply rechecks the preview and accounting binding, then atomically appends an
immutable receipt containing original provider/run/custody evidence, checksum,
separate cache counts and corrected totals. The positively stopped open provider
segment is closed as **aborted**, never completed; its previous raw evidence is
preserved in the receipt. The task worker's unknown result remains unknown.
Provider and task projections use the receipt instead of double counting old
segment/pod totals. Future segments append their own usage. Native receipts survive
history archival and cannot be updated/deleted.

Missing non-worker/reviewer telemetry remains a separate gate; this is not an
override for phase or isolated-review accounting. Existing budgets remain exactly
unchanged. After reconciliation, use the ordinary supported task budget control
only with explicit owner approval, then re-inspect genuine continuation prerequisites.
Do not fabricate phase buckets, clear retry/custody records, erase history or
change a cap merely to suppress incomplete telemetry.
