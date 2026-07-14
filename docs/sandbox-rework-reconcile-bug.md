# Bug: sandbox rework/resume fails on host/container HEAD divergence

## Summary

On **sandbox** pods, `resume` / `rework` (reject → agent rework) reliably fails at
the pre-validation workspace reconcile with:

```
ValidationWorkspaceReconcileError: Host worktree HEAD <A> and container workspace HEAD <B> diverged before validation
    at prepareWorkspaceForValidation (packages/daemon/src/pods/pod-manager.ts:3736)
    at triggerValidation
    at handleCompletion
    at rejectSession
```

The worktree is then flagged `worktreeCompromised: true`, which blocks any further
resume/rework/PR. **Every sandbox rework hits this** — reproduced on two independent
pods (`biological-amphibian`, `tasty-halibut`) back-to-back with identical outcome.

This was **exposed** (not caused) by the Codex exit-code fix in `de4ee01c` (#200):
before that fix, sandbox pods died earlier on the spurious "exit code did not resolve
→ fatal" path and never reached this reconcile step. With that layer removed, reworks
now run to completion and surface this deeper bug.

## Impact / blast radius

- **All sandbox pods** that reach `prepareWorkspaceForValidation` via resume or rework.
- Failure is terminal for the pod: worktree is quarantined (`worktreeCompromised`),
  and the agent's rework changes are stranded in the divergence (not delivered to a PR).
- Docker pods are likely unaffected in practice (host worktree is bind-mounted, so
  HEADs stay linear), but the guard is shared.

## Root cause (confirmed mechanism)

`prepareWorkspaceForValidation` (`pod-manager.ts:3677`) reconciles host worktree HEAD
vs container `/workspace` HEAD before validation. It handles three cases:

1. `hostHead === containerHead` → sync-back if container dirty. OK.
2. containerHead is ancestor of hostHead (**host ahead**) → `resetContainerWorkspaceToHead`. OK.
3. hostHead is ancestor of containerHead (**container ahead**, normal after agent work) → `syncWorkspaceBack`. OK.
4. **Otherwise (neither is an ancestor of the other → true divergence) → throw.** ← we land here.

From the daemon journal, immediately before the throw:

```
"Refreshed host worktree index after sync-back"
"Discarded staged mode-only changes before auto-commit" (scripts/deploy-hosted-daemon.sh, scripts/install-desktop.sh)
"auto-commit message used heuristic/template fallback — daemon-side LLM helper failed" (provider_not_callable)
"Auto-committed pending changes"   → host HEAD becomes 2e9fb212…
"Failed to sync workspace before validation" → ValidationWorkspaceReconcileError (host 2e9fb212… vs container f2ec13fb…)
```

The **daemon's own host-side auto-commit** produces a host HEAD (`2e9fb212`) that is
**not a descendant of the container HEAD** (`f2ec13fb`). Both ancestry probes
(`isAncestorInContainer`) return false, so the reconcile falls through to the divergence
throw. In effect the daemon commits on the host in a way the guard then rejects.

## Open question (needs a focused repro)

Why is the host auto-commit not a linear descendant of the container HEAD? Working
hypothesis: the resume/rework worktree setup resets/rebases the host branch to base
before re-committing the synced-back working tree, orphaning the container's prior
auto-commit (`f2ec13fb`) so the new host commit shares no path to it. Needs confirmation
by tracing the resume/rework host-worktree prep + the order of sync-back vs. auto-commit.

## Fix (shipped)

Implemented the recoverable-path direction: on **sandbox** pods, `prepareWorkspaceForValidation`
no longer quarantines on true divergence. Instead it **grafts** the host worktree's tree onto
the container HEAD and continues:

1. Log full lineage (`merge-base`, both tree SHAs) — this is the focused repro data the open
   question needed; it lands on every real divergence now.
2. Ensure the container HEAD is reachable on the host (usually already pushed by sync-back;
   otherwise push it to a throwaway `refs/autopod-reconcile/<podId>` ref).
3. `git reset --soft <containerHead>` then commit the retained tree → a linear child of the
   container HEAD (skips the commit when the trees already match).
4. `resetContainerWorkspaceToHead(graftedHead)` — container follows the linear host HEAD.

This preserves 100% of the agent's working-tree content (the host commit's *tree* is the agent
state) while restoring linear ancestry, so validation and PR delivery proceed. Docker pods keep
the strict throw — their host worktree is bind-mounted and should stay linear, so a divergence
there is a genuine anomaly worth surfacing.

Code:
- `packages/daemon/src/worktrees/graft-reconcile.ts` — `graftHostTreeOntoBase` (pure, real-git tested)
- `packages/daemon/src/pods/pod-manager.ts` — `reconcileDivergedSandboxWorkspace` orchestrates the
  container-side push/reset around the graft; wired in before the divergence throw.

The lineage logging still lets us close the **open question** (why the host auto-commit lands off
the container HEAD) with real data from the next occurrence, but the graft makes the answer
non-blocking either way.

## Recovering already-stranded pods

Pods quarantined *before* the fix (`biological-amphibian`, `tasty-halibut`) do not self-heal —
their `worktreeCompromised` flag blocks re-validation. Their work is **not lost**: the host
worktree HEAD is the divergent auto-commit, which carries the full agent tree. Runbook (after
deploying this fix to the daemon that owns them):

1. `POST /pods/:id/recover-worktree` — clears `worktreeCompromised` and restores the worktree
   from HEAD (or from the live container if still up).
2. `POST /pods/:id/resume` (revalidate) or reject→rework. With the graft fix deployed, any
   remaining container/host divergence now self-heals instead of re-stranding.

## Secondary (separate, non-blocking)

Memory-extraction / container reviewer is configured with `gpt-5-mini`, which Codex
rejects on a ChatGPT account:

```
"The 'gpt-5-mini' model is not supported when using Codex with a ChatGPT account."
→ reviewer_unavailable → "Reviewer model unavailable for memory extraction"
```

Doesn't block validation, but it's log noise and disables memory extraction on
ChatGPT-auth Codex. Worth pinning the reviewer to a supported model for that auth mode.

## Repro

1. Sandbox pod reaches `failed` with committed work in its worktree.
2. `POST /pods/:id/resume` (revalidate) or `POST /pods/:id/reject` (rework).
3. Agent rework completes; on `prepareWorkspaceForValidation`, host auto-commit diverges
   from container HEAD → `ValidationWorkspaceReconcileError` → `worktreeCompromised: true`.

## References

- `packages/daemon/src/pods/pod-manager.ts:3677` (`prepareWorkspaceForValidation`)
- `packages/daemon/src/pods/pod-manager.ts:3736` (divergence throw)
- `packages/daemon/src/pods/pod-manager.ts:329` (`ValidationWorkspaceReconcileError`)
- `packages/daemon/src/worktrees/local-worktree-manager.ts:1009` (mode-only discard + auto-commit)
- Exposed after `de4ee01c` (#200, Codex exit-code non-fatal-after-completion fix)
