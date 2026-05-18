# Update From Base

## Problem

Validation can fail on a pod even though the underlying issue has already been
fixed on the base branch. A common case is a dependency vulnerability or shared
test failure: multiple pods validate after the failure appears, but the fix lands
on `main` while those pods are still validating or parked in failure review.

Today the operator can interrupt validation or revalidate, but there is no
single, explicit "pull in latest base, then try validation again" action for the
pod's branch. The workaround is manual git surgery in the worktree or asking an
agent to fix something that is already fixed upstream.

## Outcome

An operator can manually update an eligible pod branch from its base branch and
restart validation without spawning another agent task.

## Users

- **The operator** running Autopod locally. They notice that a pod is failing on
  a problem already fixed upstream and want to recover the pod branch cheaply.
- **Pod authors / agents** benefit indirectly because validation feedback is not
  sent for already-fixed upstream issues.
- **Desktop users** get the primary v1 UX in the Validation tab.
- **CLI users** get the same action for scripted or terminal-first workflows.

## Success Signal

1. `POST /pods/:podId/update-from-base` returns a typed outcome for
   `validating`, `failed`, and `review_required` pods and refuses unrelated
   statuses. *(Brief 01 AC.)*
2. A clean rebase onto the current base branch resets validation attempts and
   starts validation again as attempt 1. *(Brief 01 AC.)*
3. A rebase conflict returns a conflict response with file paths, leaves the
   pod reviewable, and does not persist a merge-block reason. *(Brief 01 AC.)*
4. `ap update-from-base <id>` resolves short IDs, prints already-up-to-date /
   queued / rebased outcomes, and exits non-zero with conflicts on conflict.
   *(Brief 02 AC.)*

The desktop Validation-tab button is reviewer-judged via Swift build/previews
and manual smoke notes because native SwiftUI surfaces do not have a firing
`api` or `web` AC in the validation engine.

## Non-goals

- No automatic update-from-base on validation failure. This is manual-only.
- No new pod status and no DB column for the pending intent.
- No new migration.
- No fix-pod changes. `merge_pending` and PR feedback recycling remain governed
  by ADR-025.
- No desktop action outside the Validation tab in v1.
- No changes to PR creation semantics. PR pods keep using the existing PR path;
  branch pods keep pushing branches; workspace/artifact/no-output modes only use
  this action when they already have an eligible worktree.
- No long-lived conflict persistence in `mergeBlockReason`.
- No agent prompt injection for this operation. Updating from base is daemon
  worktree control-plane work, not agent work.

## Glossary

- **Update From Base** - manual operator action that rebases the pod branch onto
  the latest `origin/<baseBranch>`, then starts validation again when the rebase
  is clean.
- **Base branch** - the pod's configured `baseBranch`, falling back to the
  profile/repo default the pod already uses. The action must use the same value
  existing validation and merge paths use.
- **Eligible pod** - a pod in `validating`, `failed`, or `review_required` with
  an existing worktree path.
- **Pending update intent** - in-memory marker used only while a currently
  validating pod is being aborted so the validation unwind can run
  update-from-base before sending correction feedback.
- **Already up to date** - the pod branch already contains the current
  `origin/<baseBranch>` tip. The action returns success and does not revalidate.
- **Conflict** - `git rebase origin/<baseBranch>` reported conflicts. The
  existing `rebaseOntoBase` helper aborts the rebase and returns the conflicted
  file list.
- **Follow-up validation** - validation run started after a clean rebase. It
  resets visible validation attempt counters and starts as attempt 1.

## Reversibility

This spec introduces a daemon route, a CLI command, and a desktop button, but no
schema or on-disk format change. Rollback is code-only: remove the route/client
method/UI action and redeploy. Branches that were already rebased by the action
remain rebased like any other manual git operation.
