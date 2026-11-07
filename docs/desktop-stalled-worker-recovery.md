# Recover a stalled Docker task from the desktop

A pod can retain `running` after a daemon restart even when its coding stream has
ended: a durable worker claim remains unresolved. Neither a quiet log nor an
agent's completion summary proves that its processes stopped. A nudge can remain
queued forever in this state.

## Desktop flow

1. Open pod detail and choose **Inspect stalled execution…**. This is available
   for ordinary running/attention tasks, including before eligibility has loaded.
   Inspection/refresh only reads evidence; it never stops or resumes anything.
   A recorded restart hold plus failure is shown as requiring execution inspection
   instead of the overview claiming **Agent running**.
2. Review the original failure, eligibility blockers and pending guidance. For an
   eligible orphaned local Docker task, enter a meaningful reason and confirm
   **Stop execution and retain work…**.
3. Wait for a **settled** receipt, not merely an accepted request. The action
   stops the exact recorded Docker container without deleting it, privately
   archives its full `/workspace` (including Git metadata and ignored files),
   verifies Git identity and synced source bytes against the canonical checkout,
   then parks the pod as `failed`. Dirty worker edits remain dirty: this action
   does not commit them. A complete archive byte/permission inventory and original
   reports are retained; ordinary executable bits are preserved, not privileged
   setuid/setgid bits or container ownership.
4. Choose **Open Validation** for the existing recovery controls. If infrastructure
   is still blocked, use **Inspect repair & continuation…** in pod detail to inspect
   a qualified environment selection. Guidance, human decisions, task-wide retry
   authorizations and budgets remain separate decisions. **Stopping does not
   repair infrastructure, pass validation or make a legacy source eligible.**

The original exit/result remains unknown, not a synthetic successful worker exit.
Its recorded failure category, validation results, reports, usage and retry history
remain unchanged. An unfinished matching worker admission is settled with outcome
`unknown` and no invented measured duration. A verified completion-cycle
settlement/preservation marker records the operator stop, not task success.
Auto-approval is disabled. No worker, checks, publication, PR, merge, dependency
step or resource deletion is requested by this action.

## Lost response, restart or incomplete preservation

The desktop saves the exact selection/request privately **before** POST. Closing
and reopening the sheet restores it. **Inspect / refresh** only observes.
**Reconcile saved request** reuses that exact body and authenticated actor. There
is no automatic resend and no replacement key after an uncertain response.

The daemon persists custody before dispatching one owned stop. Concurrent identical
requests coalesce. A dispatched stop is never repeated, including after a daemon
restart. If Docker still reports running/unknown, the receipt explains that provider
recovery is required; silence or a timeout is not proof of a failed dispatch. Do
not use Kick/Kill, raw Docker operations or database edits to bypass the hold.

Source/report/configuration, completion cycle, generation or provider drift fails
closed. Incomplete preservation retains the old run and resources. A completed
archive is sealed with Git identity and a complete bounded byte/mode inventory;
reconciliation verifies it instead of overwriting it. Canonical import reads that
exact sealed archive (including its Git storage), not a second provider export.
Directory/symlink type changes are mirrored without following old destination
aliases or deleting excluded caches. Older already-sealed representations remain
unchanged; a failed import retains the same request and never dispatches another stop. If canonical sync/import
has not reached that exact Git identity and synced source bytes, settlement remains blocked. Ignored
bytes are retained in the full archive even when ordinary sync excludes caches.
Archive paths remain protected from application worktree mutation/orphan cleanup.
A later explicitly selected ordinary recovery owns its normal effects on the
original resource; it does not delete this archive or historical failure evidence.

## Deliberate limits

- Only an ordinary blocked `running` or `failed` local Docker task with one exact
  unsettled current-generation/current-cycle worker claim is eligible. The
  identity must be a dispatch-recorded **full 64-character Docker ID**, not a
  name or a guess from a mutable pod pointer. A fresh exact-ID inspection selects
  its Docker engine namespace; it does not pretend an absent historical engine
  namespace was recorded.
- An active worker/control/validation, another unsettled admission, shared
  container, sidecar, pending human decision, source adoption, retained
  continuation, approval rewrite or publication/cleanup ownership blocks this
  action. Existing controls own those cases. Discovery does not imply eligibility.
- Sandboxes, interactive workspaces and native Goals have different ownership
  and termination semantics. A suspended sandbox is not a stopped Docker process.
- The initial host checkout must be clean so unrelated host edits are not
  overwritten. Final worker source may be dirty; hardened preservation inspection
  observes it without weakening the separate clean-source adoption rules.
  Executable Git filters, fsmonitor/hooks and sparse/submodule source retain the
  existing refusal/disable policy. Unsupported source is retained, not waived.
- Full stopped-workspace inventories stream every byte, including dependency
  caches, rather than applying the artifact-output 1 GiB/entry caps. Those caps
  remain unchanged for artifact/API evidence. Export, disk or inventory failures
  retain the original and do not certify an incomplete copy. Dependency caches
  stay in the full archive even when excluded from ordinary source sync.
- A missing/older daemon displays an unsupported-recovery message. There is no
  destructive fallback. Installation alone does not recover any live pod.

The authenticated API is `GET/POST /pods/:podId/stalled-worker-recovery`. POST
accepts only `requestKey`, `expectedGeneration`, `expectedBinding` and `reason`.
A pending receipt is HTTP 202; a settled receipt is HTTP 200. A strict identity/body
or actor mismatch is refused. Migration 244 adds durable custody; do not downgrade
to a binary unaware of pending stop-and-retain claims.

## Qualification

Focused backend coverage:

```sh
npx pnpm --filter @autopod/daemon exec vitest run src/pods/stalled-worker-recovery.test.ts
swift test --package-path packages/desktop --no-parallel --filter StalledWorkerRecovery
```

The opt-in real Docker fixture uses an already cached exact image with `sleep`,
no network, no mounts, a private SQLite database and one disposable test-owned
container. It exercises the actual facade, Docker stop/archive adapter, hardened
Git identity, dirty-source sync, executable-mode preservation and custody. Its cleanup removes only the container
created by that test. It does not operate on a live pod or prove hosted acceptance.

```sh
AUTOPOD_STALLED_DOCKER_FIXTURE_IMAGE=sha256:EXACT_CACHED_IMAGE \
AUTOPOD_STALLED_DOCKER_FIXTURE_SOCKET=/path/to/local/docker.sock \
npx pnpm --filter @autopod/daemon exec vitest run \
  src/pods/stalled-worker-recovery.test.ts -t 'real disposable Docker'
```
