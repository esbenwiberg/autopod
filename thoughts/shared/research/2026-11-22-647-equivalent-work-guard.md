---
date: 2026-11-22T00:00:00+00:00
researcher: Claude (Autopod pod architectural-partridge)
git_commit: 9e6b180846a11e9f028f27b30d992e492d52a910
branch: fix/647-equivalent-work-guard
repository: autopod
topic: "#647 — equivalent-work guard, launch preview, and rerun branch handling"
tags: [research, codebase, dispatch-preflight, launch-preview, rerun]
status: complete
last_updated: 2026-11-22
last_updated_by: Claude
---

# Research: #647 equivalent-work guard / preview / rerun branch

## Research Question

How does the dispatch preflight "equivalent active work" guard decide to block a
launch, why does `ap run --preview` not surface it, and why does `ap rerun` lose
the requested output branch?

## Summary

- The guard runs **only during provisioning**, after admission, after the worktree
  has been created and the fresh base SHA fetched
  (`packages/daemon/src/pods/provisioning-workspace.ts:465-485`). It calls
  `DispatchPreflightLedger.inspect()` which *writes* a receipt row and returns
  `review_required` when any equivalent receipt/legacy request exists for a
  non-terminal pod.
- "Equivalent" = same repository identity, same base branch, same
  `sha256(canonical({task, contract}))` work hash, different `task_id`, prior
  receipt `status='admitted'`, prior pod status not in
  `('complete','failed','killed','rejected')`
  (`dispatch-preflight-ledger.ts:149-155`, `:600-605`). Status is the only
  liveness signal; a `paused` pod with zero changes counts exactly like a
  running pod. No per-conflict evidence beyond `podId/executionId/status/evidence`
  is recorded (`shared/src/types/dispatch-preflight.ts:20-25`).
- The conflict scan needs repository, base branch and work hash only; the base
  SHA is merely validated and stored (`dispatch-preflight-ledger.ts:406-411,
  670-685`).
- Preview (`ap run --preview`) calls `POST /launch/resolve`
  (`cli/src/commands/launch.ts:276-293`, `cli/src/api/client.ts:317`,
  `daemon/src/api/routes/configuration.ts:344-348`) which only resolves an
  `EffectiveLaunchConfig`. It never consults the ledger. The response is
  digest-covered (`launch-resolver.ts:542-543`) and the digest is used as
  `expectedDigest` on launch, so the config body cannot carry extra advisory data
  without changing the digest. Desktop also calls `/launch/resolve`
  (`desktop/Sources/AutopodClient/DaemonAPI.swift:235`).
- An intentional rerun is admitted by the ledger when the rerun intent names the
  conflicting execution directly (`conflicts.size === 1 &&
  conflicts.has(intent.source_execution_id)`) or names a blocked request whose
  recorded conflicts match exactly (`dispatch-preflight-ledger.ts:640-668`).
  `work.intentionalRerun` is accepted on any launch request
  (`shared/src/schemas/launch-work.schema.ts:10`,
  `shared/src/schemas/pod.schema.ts:85-92`) but `ap run` has no flag for it;
  only `ap rerun <pod>` sets it (`cli/src/commands/pod.ts:200-235`).
- `ap rerun` fetches `GET /pods/:id/rerun-template`
  (`daemon/src/api/routes/pods.ts:888-938`). For composable pods the template
  copies selected `work` fields but **omits `work.branch`**, and uses
  `source.configuration: 'original'`. `deriveLaunch` for a `follow-up` only
  inherits `specContextFiles`/`inputBundle` from the parent's work
  (`configuration/derive-launch.ts:62-83`), so the derived launch has no branch and
  admission names it `${branchPrefix}${id}`
  (`pods/composable-pod-admission.ts:122-128`). The frozen config of the source
  (B) is reused by design (`configuration: 'original'`).

## Detailed Findings

### Guard call site
- `provisioning-workspace.ts:465-485` — skipped for recovery, `skipAgent` and
  interactive pods. Throws `AutopodError(..., 'EQUIVALENT_WORK_REVIEW_REQUIRED', 409)`
  listing only pod IDs; message suggests "create an intentional rerun with a
  recorded reason" but not how.

### Ledger (`pods/dispatch-preflight-ledger.ts`)
- `inspect` (`:395-692`) is a transaction: validates generation, base SHA,
  repository binding and rerun-intent binding; computes PR-repair scoping;
  collects conflicts from `DISPATCH_CANDIDATES_SQL` (receipts), the generic repair
  query (repair stubs only), and legacy requests without receipts; then inserts an
  `execution_dispatch_preflights` row and returns it.
- `registerRerun` (`:346-394`) requires the rerun pod to have the same work hash
  as the source and a distinct task id; records `execution_rerun_intents`.
- `findRerun` (`:321-345`) gives idempotency on `requestKey`.
- `latest` (`:694-701`) backs `GET /pods/:id/dispatch-preflight` and
  `ap dispatch-preflight` (`cli/src/commands/pod.ts:236-257`).
- Existing tests: `dispatch-preflight-ledger.test.ts`,
  `dispatch-active-only.test.ts`, `dispatch-repair-identity.test.ts`,
  `empty-workspace-rerun.test.ts`.

### Admission
- Composable: `admission-resolved.ts:26-139` → `admitComposablePod`
  (`composable-pod-admission.ts`). Intentional reruns require a human actor and
  are idempotent through `findRerun`. A separate *touches-overlap* preflight
  (`preflight.ts`, `intentional-rerun-preflight.ts`) exists; it is independent of
  the equivalent-work ledger.
- Legacy: `admission-legacy.ts` — same rerun idempotency; branch default
  `${prefix}${id}` (`:239-261`).
- `pod-repository.ts:1064-1070` registers request binding and rerun intent at
  insert time.

### Pod evidence available for liveness/productivity
`Pod` (`shared/src/types/pod.ts`) exposes `status`, `pauseReason`
(`budget|manual|provider_limit`), `filesChanged`, `linesAdded`, `linesRemoved`,
`commitCount`, `prUrl`, `validationAttempts`, `containerId`, `lastHeartbeatAt`.
`PodStatus` includes `paused`, `handoff`, `awaiting_input`, `review_required`, etc.

### Worktree branch reuse
`local-worktree-manager.ts:883-960` — if the requested branch exists on the remote
it is used as the start point; if a local worktree already holds it, that worktree
is force-removed. Admission does not check whether another live pod uses the same
branch.

## Code References
- `packages/daemon/src/pods/provisioning-workspace.ts:465-485` — guard.
- `packages/daemon/src/pods/dispatch-preflight-ledger.ts:149-155,517-668` — conflict collection/authorization.
- `packages/daemon/src/api/routes/configuration.ts:344-348` — `/launch/resolve`.
- `packages/cli/src/commands/launch.ts:276-305` — preview/launch.
- `packages/daemon/src/api/routes/pods.ts:888-946` — rerun template, dispatch-preflight GET.
- `packages/daemon/src/configuration/derive-launch.ts:62-83` — follow-up work inheritance.
- `packages/daemon/src/pods/composable-pod-admission.ts:119-128` — branch naming.
- `packages/cli/src/commands/pod.ts:200-257` — `ap rerun`, `ap dispatch-preflight`.
- `packages/mobile-web/src/components/DispatchPreflightPanel.tsx:66` — mobile rerun uses the template.

## Architecture Documentation
- Ledger evidence is append-only; conflicts are stored as JSON in
  `execution_dispatch_preflights.conflicts` (no schema change needed for extra
  optional per-conflict fields).
- Launch request schemas are `.strict()` (`launch-config.schema.ts:580-581`), so a
  template response must remain a pure `LaunchRequest`.

## Open Questions
None for current state.
