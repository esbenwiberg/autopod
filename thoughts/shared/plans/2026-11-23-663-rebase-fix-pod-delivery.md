# #663 Rebase fix pods on Docker + force-approve dead end — Implementation Plan

## Overview

On local Docker, a canonical PR fix pod whose agent rebased the PR branch onto
its base ends up quarantined (`worktreeCompromised`) because the container's
rewritten branch can't fast-forward the host branch. A force approve then moves
it into an undeliverable `validated` state. This plan:

1. **RC1** lets the daemon adopt the container's rewritten branch tip into the
   host bare **only** when it is provably a rebase of the current host branch
   for a canonical PR fix pod. Adoption happens at the single place container
   commits reach the host (the staging-ref push), so completion, validation and
   live recovery all see a linear host branch. Everything else keeps today's
   fail-closed behaviour (refused push; strict `ValidationWorkspaceReconcileError`
   at validation). Delivery is unchanged: it already force-pushes with a lease
   against the recorded PR head.
2. **RC3** refuses force approve with a 409 while `worktreeCompromised` is set,
   naming the recovery path, and leaves the pod unchanged.

Research: `thoughts/shared/research/2026-11-23-663-rebase-fix-pod-delivery.md`.

## Current State

- `pushCommitsToBareViaStagingRef` (`worktrees/bare-push.ts:70`) refuses any
  non-FF staging tip. Docker sync-back still mirrors files, so completion
  auto-commits the rebased tree on top of the old head (daemon commit X).
- `prepareWorkspaceForValidation` (`pods/validation-workspace.ts:398`) throws on
  Docker divergence; the trigger parks the pod as compromised.
- `forceApprove` (`pods/approval-controls.ts:140`) ignores
  `worktreeCompromised`; approval refuses compromised source later.
- Fix delivery (`pods/fix-delivery.ts`, `worktrees/fix-source-publication.ts`)
  already uses `--force-with-lease=<branch>:<journal expectedHeadSha>`.

## Desired End State

- A Docker PR-fix pod whose agent ran `git rebase origin/<base>` (with conflict
  resolution) completes sync-back with the host branch at the rebased head, no
  daemon "chore" squash commit, validation runs, and delivery force-pushes the
  rebased head with a lease against the recorded PR head.
- Any other divergence (non-fix pod, sandbox, dropped/squashed/reworded
  commits, base moved backwards, different branch, missing base ref) behaves
  exactly as today.
- `forceApprove` on a compromised pod → `AutopodError` 409
  `WORKTREE_COMPROMISED`; status, waiver, decision and correction fields
  unchanged.

### Key Discoveries

- Divergence first appears at completion sync, not validation (research §2).
- The bare is shared per repo; requiring descent from the *current* bare
  `origin/<base>` would false-negative whenever another pod fetched base.
- Rebase preserves author ident/date/subject; `git cherry` covers patch-equal
  replays and commits already upstream; merges are excluded by `git cherry`.

## What We're NOT Doing

- RC2 / #648 (runtime turn completion), #670 (agent-failure preservation,
  `provider-continuation.ts`, `continuation-controls.ts`) — untouched.
- Sandbox target: keeps its checkpoint/graft path.
- No change to the #667 conflict prompt (merge stays the preferred,
  fast-forward instruction); adoption is the safety net for agents that rebase.
- No migration, no new pod state, no new API route, no desktop/CLI changes.
- No repair for pods already stuck in `validated` + compromised (see open
  questions).
- No change to delivery/lease code beyond tests.

## Implementation Approach

A host-side, read-only **rebase proof** decides whether a non-FF staging tip
may replace the bare branch tip. `pushCommitsToBareViaStagingRef` gains an
optional authorizer; when it returns `authorized`, the existing CAS
`update-ref refs/heads/<branch> <staging> <E>` is reused unchanged. The
workspace transfer resolves the authorizer per pod from a policy dependency
wired in `pod-manager.ts`.

### Rebase proof (all must hold; otherwise `{ ok: false, reason }`)

Inputs: bare git dir, predecessor **E** (bare branch tip captured before push),
candidate **R** (staging tip), container branch name, policy
`{ branch, baseBranch }`.

1. Container branch == policy branch (no cross-branch rewrite).
2. `refs/remotes/origin/<baseBranch>` resolves in the bare (tip **B**).
3. `oldFork = merge-base(E, B)`, `newFork = merge-base(R, B)` both exist and
   `oldFork` is an ancestor of (or equal to) `newFork` — the rewrite never
   moves the branch backwards on its base. (R containing the *current* B is not
   required; delivery re-rebases on a fresh fetch.)
4. Every non-merge commit of E not in R (`git cherry R E`) is accounted for:
   `-` (patch-equivalent already in R, including commits that landed upstream),
   or `+` matched one-to-one against `git log --no-merges R ^E` by
   (author name, author email, raw author date, subject).
5. Bounded: refuse if E has more than a fixed number of commits to account for
   (e.g. 500) to keep the check cheap; refusal is fail-closed.

No additional constraint on extra commits in R: they are new agent work,
validated and reviewed like any other change.

## Phase 1: Rebase proof + authorized promote in the bare push

### Changes

**New `packages/daemon/src/worktrees/rebase-rewrite-proof.ts`**
- `proveRebaseRewrite(runBareGit, { predecessor, candidate, baseRef })` →
  `{ ok: true; oldFork; newFork; baseTip; replayed; upstream }` |
  `{ ok: false; reason }`. Uses only read-only git plumbing
  (`rev-parse`, `merge-base`, `merge-base --is-ancestor`, `cherry`, `log`).

**`packages/daemon/src/worktrees/bare-push.ts`**
- `pushCommitsToBareViaStagingRef(runGit, bare, podId, assertCurrent, options?)`
  with `options.authorizeRewrite?(input: { bareRepoPath; branch; expectedOld;
  candidate }) → Promise<{ authorized: true } | { authorized: false; reason }>`.
- In the non-FF branch: resolve the staging tip, call the authorizer; if
  authorized, fall through to the existing CAS `update-ref` against
  `expectedOld`; return `{ pushed: true, rewrite: { from, to } }`. Otherwise
  return the existing `non-fast-forward…` reason plus `; rewrite refused: …`.
  No authorizer → identical behaviour to today.

### Tests (`bare-push.test.ts`, `rebase-rewrite-proof.test.ts`, real git)

- Proof accepts: clean rebase onto a newer base; rebase with a conflict-resolved
  commit; E containing an earlier merge of base; commits dropped because they
  are already upstream; R with an extra agent commit on top.
- Proof refuses: dropped commit; squashed commits; reworded subject; base moved
  backwards; missing base ref; unrelated history; over the bound.
- Push: non-FF + authorized → branch at R, staging ref cleaned, `rewrite`
  reported; non-FF + refused → branch unchanged, reason contains refusal;
  concurrent ref move between capture and promote → CAS fails, unchanged.

### Success Criteria

- `npx pnpm --filter @autopod/daemon exec vitest run src/worktrees/bare-push.test.ts src/worktrees/rebase-rewrite-proof.test.ts`
- `npx pnpm --filter @autopod/daemon exec tsc --noEmit` (or package typecheck), Biome on changed files.

## Phase 2: Wire the policy through workspace transfer and validation prep

### Changes

**New `packages/daemon/src/pods/fix-history-rewrite-policy.ts`**
- `historyRewritePolicyForPod(pod, parent, defaultBranch)` → `{ branch,
  baseBranch } | null`. Non-null only when: `executionTarget === 'local'`,
  `linkedPodId` set, `parent?.fixPodId === pod.id`, `outputMode !==
  'workspace'`, `prUrl` and `branch` set. `baseBranch = pod.baseBranch ??
  defaultBranch ?? 'main'` (same rule as fix delivery).

**`packages/daemon/src/pods/workspace-transfer.ts`**
- Dependencies gain optional `historyRewritePolicy?(podId)` and
  `onHistoryRewriteAdopted?(podId, { from, to, baseBranch })`.
- Build one authorizer per call (bare path, policy, `proveRebaseRewrite`) and
  pass it to all three `pushCommitsToBareViaStagingRef` call sites (in-container
  sync, archive fallback, live recovery). Log + callback on adoption.
- Extract the in-container "validate alternates → push to bare" block into a
  helper and expose `adoptContainerHistoryRewrite(containerId, worktreePath,
  cm, podId): Promise<boolean>` — push/promote only, **no file mirroring**;
  returns true only when a rewrite was adopted.

**`packages/daemon/src/pods/validation-workspace.ts`**
- Optional dependency `adoptContainerHistoryRewrite`. In the true-divergence
  branch for `executionTarget === 'local'`: call it; if it returns true, run
  the normal `syncWorkspaceBack` (now host == container HEAD, so it only
  mirrors files and refreshes the index), then return. Otherwise throw the
  existing `ValidationWorkspaceReconcileError` (unchanged message). Update the
  "Docker pods keep the strict throw" comment.

**`packages/daemon/src/pods/pod-manager.ts`** (wiring only)
- Pass `historyRewritePolicy` (reads pod + parent via `podRepo`, default
  branch via `executionForPod`) and `onHistoryRewriteAdopted` (activity:
  "Adopted agent rebase of `<branch>` onto `origin/<base>` (`abc1234` →
  `def5678`); delivery publishes with a lease against the recorded PR head.").
- Pass `adoptContainerHistoryRewrite` into `createValidationWorkspace`.

### Tests

- `fix-history-rewrite-policy.test.ts`: canonical fix → policy; sandbox,
  non-linked, manual-fix workspace, parent pointing elsewhere, missing prUrl →
  null.
- `workspace-transfer.test.ts` (real git + alternates, mocked exec like the
  existing fixture): Docker fix pod, container rebased onto moved base with a
  conflict → `syncWorkspaceBack` returns `pushed: true`, host HEAD = R, host
  files = container files, index clean, callback fired; same with policy null →
  `pushed: false`, host branch unchanged (today's behaviour).
- `validation-workspace.test.ts`: (a) host at E, container at R (authorized) →
  validation prep adopts, host HEAD = container HEAD = R, no throw; (b) existing
  "refuses actual local divergence without mutating…" kept; (c) unrelated
  divergence with policy present (dropped commit) → throws, refs/index/files
  unchanged.
- **End-to-end real-git test** (new `pods/rebase-fix-delivery.git.test.ts`):
  origin remote with `main` + PR branch at P → move `main` with a conflicting
  change → `LocalWorktreeManager.create` (bare cache + linked host worktree) →
  container clone with alternates, `git rebase origin/main`, resolve, continue
  → `syncWorkspaceBack` (completion) → `prepareWorkspaceForValidation` (no
  throw, host == R) → `rebaseOntoBase` (`alreadyUpToDate`) → `pushBranch(force,
  expectedRemoteCommitSha = P)` → origin branch = R. Variants: lease mismatch
  (origin moved after P) → push refused, origin unchanged; unrelated
  divergence → validation prep throws `ValidationWorkspaceReconcileError`.

### Success Criteria

- Targeted vitest files above pass; existing `workspace-transfer`,
  `validation-workspace`, `bare-push`, `completion-*`, `validation-trigger*`,
  `fix-delivery`, `local-worktree-manager.git` suites pass.
- Daemon typecheck + Biome clean.

## Phase 3: Refuse force approve on a compromised worktree

### Changes

**`packages/daemon/src/pods/approval-controls.ts`**
- After the status/`allowed` check and before any decision handling or
  transaction: if `pod.worktreeCompromised`, throw `AutopodError(…,
  'WORKTREE_COMPROMISED', 409)` with: "Cannot force-approve pod X: its worktree
  is marked compromised, so approval could not deliver the result. Recover the
  worktree first (Recover worktree / POST /pods/X/recover-worktree), then
  revalidate; or kill the pod and deliver manually." Applies to the
  decision-repair branch as well (a compromised validated pod can't deliver
  either).

### Tests

- `approval-controls.test.ts`: failed + compromised → 409
  `WORKTREE_COMPROMISED`; status still `failed`; no waiver, no escalation
  response, no `lastCorrectionMessage`, no dependents triggered. Same for
  `awaiting_input` with a pending decision (decision retained).
  Not compromised → existing behaviour unchanged.
- Route-level check (existing pods route test file, if it covers
  `force-approve`): HTTP 409 body carries the code/message.

### Success Criteria

- `approval-controls.test.ts` (+ route test) pass.

## Phase 4: Docs and final verification

- `docs/reference/validation.md` fix-pod paragraph: on local Docker, an agent
  rebase is adopted only when proven (rules above); otherwise the worktree is
  quarantined. Force approve refuses compromised worktrees.
- `packages/daemon/CLAUDE.md`: one short note near validation/workspace sync if
  appropriate (keep minimal).
- Run: daemon targeted suites in batches, `npx pnpm --filter @autopod/daemon
  typecheck` (or `tsc --noEmit`), `npx pnpm lint` (Biome). Full daemon suite in
  batches if time permits; report what ran.

## Commits (conventional, no push)

1. `docs(thoughts): research and plan for #663 rebase fix pod delivery`
2. `feat(daemon): prove and adopt rebased branch tips in bare sync-back` (Phase 1)
3. `fix(daemon): adopt proven fix-pod rebases on Docker before validation` (Phase 2)
4. `fix(daemon): refuse force approve on compromised worktrees` (Phase 3)
5. `docs: describe Docker fix-pod rebase adoption and force-approve refusal` (Phase 4)

## Risks / Trade-offs

- **Fingerprint forgery**: an agent could fake author/date/subject to "account
  for" a dropped commit. Accepted: the agent can already write any content;
  validation + AI review + PR review cover content. The proof guards against
  accidental loss and infrastructure anomalies, not a malicious agent.
- **Amended/reworded/squashed rebases** are refused (fail closed → today's
  quarantine). RC3 ensures this is no longer a force-approve dead end.
- **Shared behaviour**: the authorizer applies to every Docker sync-back for a
  canonical fix pod (completion, validation evidence, preservation, live
  recovery). This is intended: the host branch should always reflect a proven
  container rewrite instead of mirroring rebased files onto the stale head.
  Non-fix pods and sandbox are untouched.
- Review diff/commit counts still use `startCommitSha` and include base
  changes — same as the #667 merge path.

## Open Questions

1. Should pods already stuck in `validated` + `worktreeCompromised` get a
   recovery path (e.g. allow `recover-worktree` + revalidate from `validated`)?
   Proposed: out of scope; document kill + manual delivery.
2. Keep the #667 "merge, don't rebase" prompt as is? Proposed: yes — merge
   stays preferred; adoption is a safety net.
3. Bound for commits to account for (proposed 500) — acceptable?
