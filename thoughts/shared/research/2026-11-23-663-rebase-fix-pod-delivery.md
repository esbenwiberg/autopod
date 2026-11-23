# #663 Rebase fix pods on Docker + force-approve dead end — Research

Scope: root causes 1 (Docker host/container divergence after an agent rebase) and
3 (force approve on a compromised worktree). Root cause 2 (background-job turn
accepted as completion) is #648; agent-failure workspace preservation is #670.

Baseline: `5e544da39` (origin/main), branch `local-pod/issues-1122/663`.

## How Docker source reaches the host

- The host worktree is a linked worktree of the per-repo bare cache
  (`LocalWorktreeManager.create`, `worktrees/local-worktree-manager.ts:810-980`).
  A fix pod is created on the PR branch from `refs/remotes/origin/<branch>`
  (the published PR head, **P**); `refs/remotes/origin/<base>` is fetched at
  provisioning under the repo lock.
- In the container the agent works on `/workspace`, a real `.git` with
  `objects/info/alternates` → `<bare>/objects` (comment at
  `pods/workspace-transfer.ts:175-191`). Container-created objects live only in
  the container until pushed.
- `syncWorkspaceBack` (Docker, `workspace-transfer.ts:213-374`):
  1. reads the bare path from alternates and checks it against
     `deriveBareRepoPath(worktreePath)`;
  2. `pushCommitsToBareViaStagingRef` (`worktrees/bare-push.ts:70-161`): push
     `HEAD` to `refs/autopod-incoming/<podId>`, require the bare branch tip
     **E** to be an ancestor of the staging tip, then
     `update-ref refs/heads/<branch> <staging> <E>` (CAS). A non-fast-forward
     returns `{ pushed: false, reason: 'non-fast-forward…' }` — never throws;
  3. **always** mirrors `/workspace` files onto the host worktree;
  4. `git reset --mixed HEAD` on the host only when pushed.
  The archive fallback (`extractWorkspaceBackAndRecoverGit`) and live recovery
  (`recoverWorktreeFromContainerOwned`) use the same push helper.

## What happens after an agent rebase (incident `characteristic-swan`)

1. Completion (`pods/completion-source.ts:111-155`): `syncWorkspaceBack` →
   push is non-FF (R = rebased head is not a descendant of E = P) →
   `pushed=false`, files are still mirrored. Auto-commit runs with
   `maxDeletions: 0`; a rebase that brings in base-side deletions trips the
   deletion guard → `recoverWorktreeFromContainer` (push refused again) →
   auto-commit with `maxDeletions: 100`. Net result on the host: a daemon
   "chore" commit **X** on top of P whose tree is the rebased tree — i.e. a
   squash of every base change since the PR fork, plus the resolution. The
   incident shows no park at this stage, matching this path.
2. Validation (`pods/validation-trigger-workflow.ts:495-528`):
   `prepareWorkspaceForValidation` (`pods/validation-workspace.ts:398-477`)
   compares host HEAD (X) and container HEAD (R): neither is an ancestor →
   sandbox would graft (`reconcileDivergedSandboxWorkspace`), Docker throws
   `ValidationWorkspaceReconcileError`. The trigger treats that error as
   non-recoverable (`validationSyncOk = false`, no
   `tryRecoverAfterWorkspaceSyncFailure`) → `parkOnWorktreeSyncFailure`
   (`pods/workspace-fences.ts:105-120`): `worktreeCompromised = true`, pod →
   `failed`. Same handling in `validation-revalidation-workflow.ts:330-367`.

So the real defect starts at **completion sync-back**, not at validation: the
first point where the rewrite is visible is the refused non-FF push, after which
the host is polluted with X. Fixing only `prepareWorkspaceForValidation` would
have to reason about X (a daemon commit whose patch is "all of base"), which
cannot be proven equivalent to anything.

### Why the sandbox graft doesn't transfer to Docker as-is

`reconcileDivergedSandboxWorkspace` keeps the **host tree** and re-parents it
onto the container HEAD (`worktrees/graft-reconcile.ts`). On sandbox the host
tree is the verified checkpoint of `/workspace`, so the host tree *is* the
authority. On Docker the container is the authority and the host tree is
whatever the last mirror wrote; the graft would also add a daemon
`autopod: reconcile…` commit and it performs no intent check — it would accept
any divergence (the issue requires the strict throw to remain for real
anomalies). Reusable pieces: the staging-ref push + CAS promote
(`pushCommitsToBareViaStagingRef`), and the "return false → caller throws"
fail-closed contract.

## Delivery already pushes with a lease

`completeFixPodAfterPush` (`pods/fix-delivery.ts:27-166`), after validation:
`worktreeManager.rebaseOntoBase` (fetch base; if base is already an ancestor of
HEAD → `alreadyUpToDate`, no rewrite) → `publishFixSource`
(`worktrees/fix-source-publication.ts:31-76`) → `pushBranch(…, { force: true,
expectedRemoteCommitSha: entry.request.config.expectedHeadSha })`.
`publishBranchWithRemote` (`local-worktree-manager.ts:1975-2030`) requires an
exact predecessor OID, re-observes the remote, and pushes
`--force-with-lease=refs/heads/<branch>:<expected>`. After a fix publishes,
the parent journal is re-planned with the new receipt SHA, so the lease is
always the last published PR head. **No delivery change is needed**: once the
host branch holds R, validation runs and delivery force-pushes R with a lease
against the recorded PR head. Real-git lease coverage already exists in
`worktrees/local-worktree-manager.git.test.ts:191-215`.

## Fix-pod identity

- `fix-admission.ts:220-245`: canonical PR fix pods have `linkedPodId =
  parent.id`, `prUrl` from the PR owner, `branch` = PR branch, `baseBranch` =
  provider-verified base for conflicts; the parent records `fixPodId`.
- `workspace-manual-fix.ts:67,97` also sets `linkedPodId` but those are
  `outputMode: 'workspace'` operator pods. Binding on
  `parent.fixPodId === pod.id` + `outputMode !== 'workspace'` + `prUrl`
  isolates canonical PR fix pods.
- Since #667 (`620ef0c7f`) the conflict prompt (`fix-policy.ts:23-39`) tells
  the agent to **merge** `origin/<base>` (option b) — fast-forward for the
  host. RC1 still matters when an agent rebases anyway (operator instruction
  "rebase onto base", older prompts, agent habit), which is what the incident
  did.

## Proving "the intended rewrite"

Experiment (git 2.54): branch with 2 commits + earlier merge of base, then
`git rebase <newer base>` with one conflict:
- `git cherry R E` lists E's non-merge commits not in R: `-` for patch-equal
  replays, `+` for the conflict-resolved commit.
- Rebase preserves author name/email/date and message, so the `+` commit
  matches a commit in `R ^E` by (author, author date, subject).
- `merge-base(R, base)` is a strict descendant of `merge-base(E, base)`.

Requiring R to contain the *current* bare `origin/<base>` is too strict: the
bare is shared per repository and other pods re-fetch `origin/<base>` at
provisioning, so the bare tip can legitimately be newer than the base the agent
rebased onto. Fix delivery already re-rebases onto a freshly fetched base before
publishing.

## Force approve (RC3)

`forceApprove` (`pods/approval-controls.ts:140-262`) allows `failed`,
`review_required`, `awaiting_input` (and a validated decision-repair case) and
never reads `worktreeCompromised`. Approval later refuses:
`approval-workflow.ts:116-117` → "Compromised source cannot be authorized by a
readiness reason." `merge-operator-recovery.ts:52` and the failed-pod recovery
commands also exclude validated+compromised pods → dead end.
Recovery that does exist for compromised pods: `POST /pods/:podId/recover-worktree`
(`api/routes/pods.ts:1856-1870`, `workspace-recovery-commands.ts:77-200`;
desktop "Recover worktree"), which has no status gate and clears the flag only
after a successful live-container/HEAD restore. There is no CLI command for
force approve or recover-worktree.

## Other observations (not in scope)

- Review diff / commit counts use `startCommitSha` (= P). After a rebase (or a
  #667-style merge) they include base changes; same as today's merge path.
- Fix delivery's post-validation `rebaseOntoBase` on a *merge*-based fix
  branch whose base moved again drops the merge and may re-conflict → "complete
  without push". Relevant to #662, not changed here.
- `recover-worktree` on an unproven Docker divergence mirrors files and
  auto-commits onto the old head, clearing the flag; a later validation diverges
  again. Pre-existing.
