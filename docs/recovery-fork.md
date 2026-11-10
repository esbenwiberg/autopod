# Recovery fork: conservative local-Docker slice

Recovery preserves the original pod, resource, host checkpoint and private evidence
permanently. It admits a separate child into the same logical task accounting.
Original budget, worker retries, validation attempts and PR-fix counters/limits
remain authoritative. PR/fix links, sessions, approvals and waivers are not inherited.

Only a clean host checkpoint from a settled original Docker/sandbox task is
supported. The new candidate must be Linux local Docker. Tracked credentials,
control paths, links, submodules, replacement refs, sparse indexes/checkouts,
assume-unchanged and skip-worktree entries are refused. Source inspection does
not change the original graph or metadata. No original configuration is copied
into the candidate Git directory. Selected supplemental files get exact literal
server-owned exclusions before normal cleanup, followed by actual candidate
byte/hash verification before coding.

The immutable handoff packet keeps the original frozen handoff instructions in
`originalFrozenHandoffInstructions` and the new human instructions in
`humanContinuationInstructions`. Historical text is separately quoted. Runtime
sessions, reasoning and raw tool payloads are omitted. Chained recovery and
pointer-only prior recovery handoffs are explicitly unsupported; a same-path
packet inside a new container is never treated as the parent's packet.

Configuration cutover must be ready during eligibility and again inside atomic
child admission after asynchronous capability checks. Existing exact operation
replay and observation remain available when the gate closes.

Fresh passing checks and independent review record an immutable receipt binding
actual clean source before/after validation, generation, resource, frozen launch,
result and completed retry admission. The first authenticated human approval
can enter without prior approval; publication still requires a separate durable
human decision bound to that exact source/check receipt. Mutable readiness,
automation, inherited approvals and passing qualification alone cannot publish.

POST rejection proof is deliberately narrow. After authentication and strict
parsing, only known read-only selection/policy/binding errors before any claim
attempt can return HTTP 409 with:

```json
{
  "code": "RECOVERY_FORK_REJECTED_BEFORE_CLAIM",
  "parentPodId": "exact URL pod",
  "requestId": "exact immutable request.id",
  "expectedBinding": "exact request.expectedBinding",
  "noOperationCreated": true,
  "error": "Safe selection-rejection explanation",
  "reasonCode": "RECOVERY_FORK_SELECTION_STALE"
}
```

The coordinator must synchronously reconfirm that no existing/replayed/conflicting
source owner exists. Generic errors (including 404), unknown infrastructure errors,
claim attempts and every later failure carry no such proof, even when a later GET
finds no operation. All responses use `Cache-Control: no-store`. Native reconsideration
still requires another authoritative exact-ID GET absence and explicit user discard;
this error never authorizes automatic resubmission or abandonment.
