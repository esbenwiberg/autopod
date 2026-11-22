# #647 Equivalent-work guard: preview, stale evidence, direct fix, rerun branch — Implementation Plan

## Overview

A deliberate relaunch was blocked at provisioning by a paused, unproductive pod;
preview did not warn; and the only remedy (`ap rerun` of the failed pod) lost the
requested output branch. This plan (1) makes the conflict visible *before*
admission through a read-only preview, (2) attaches evidence-based
`active`/`stale` assessments to every conflict, (3) gives the original launch a
direct fix (`ap run --rerun-of <pod> --rerun-reason …`, or `ap kill <pod>`), and
(4) keeps the requested branch on `ap rerun` when it is free.

## Current State Analysis

See `thoughts/shared/research/2026-11-22-647-equivalent-work-guard.md`. Key facts:

- Guard runs only at provisioning (`provisioning-workspace.ts:465-485`) via the
  writing `inspect()` transaction (`dispatch-preflight-ledger.ts:395-692`).
- Liveness = pod status only (`DISPATCH_CANDIDATES_SQL`, `:149-155`).
- Preview (`/launch/resolve`) never consults the ledger; its body is digest-bound.
- Intentional rerun naming the conflicting pod is already authorized by the
  ledger (`:664-668`), but `ap run` cannot express it.
- Rerun template omits `work.branch` (`api/routes/pods.ts:913-923`).

## Desired End State

1. `ap run --preview` prints an "Equivalent work" section. On conflict it lists
   each conflicting pod with status and `active`/`stale` assessment + reasons,
   prints direct fixes, and exits non-zero (exit code 2). `--json` keeps stdout
   as the effective config; the conflict report goes to stderr.
2. `ap run` (non-preview, fresh request) runs the same read-only check before
   admission and refuses to create a pod when review is required, printing the
   direct fixes — unless `--rerun-of <podId> --rerun-reason <text>` is supplied.
   Saved exact replays (`--config` with `expectedDigest`) are unchanged.
3. The provisioning guard stays authoritative and still blocks every
   non-authorized conflict, but its message now lists each conflict with status
   and assessment and names the direct fixes.
4. Every recorded conflict (receipt JSON and preview) carries an optional
   `assessment: { classification: 'active' | 'stale'; reasons: string[] }`;
   `ap dispatch-preflight` prints it.
5. `ap rerun` / `GET /pods/:id/rerun-template` keep the source's requested
   output branch when no other non-terminal pod holds it and it is not the base
   branch; otherwise the template omits it (auto `${prefix}<id>` branch) and the
   CLI prints why.

### Key Discoveries
- Conflict scan needs only repository, base branch, work hash, and a task id to
  exclude — no base SHA (`dispatch-preflight-ledger.ts:517-630`).
- Persisted conflicts are JSON; adding an optional field needs no migration.
- Launch request schemas are strict; the rerun template must stay a pure request.

## Decision (needs owner approval): stale pods still block

Option A (recommended): **stale is advisory, still blocking.** Classify, show,
and offer the one-step fix; do not auto-admit. Rationale: "paused" pods can be
resumed by a human (`approveBudgetPause`, Resume, `ap tell`) and "continuation
impossible" (e.g. #646 accounting) is not provable from pod columns; the
constraint forbids silently ignoring conflicts. The direct fix is a single flag
on the original launch, recorded in the rerun-intent ledger.

Option B: stale conflicts are recorded but do not block. Faster for the user;
risk of duplicate work if the stale pod is later resumed.

Stale criteria (all required; otherwise `active`):
`status === 'paused'`, `filesChanged === 0`, `linesAdded === 0`,
`linesRemoved === 0`, `commitCount === 0`, `prUrl` empty, `validationAttempts === 0`.
Reasons enumerate the evidence (e.g. `paused (provider_limit)`, `no source changes`,
`no commits`, `no validation`, `no PR`). Non-paused statuses are always `active`
(a `failed` pod already does not conflict). Missing/archived pod → `active`.

## What We're NOT Doing
- No change to which pods conflict, to authorization rules, or to the work hash.
- No auto-kill/supersede of the stale pod; no new "supersede" control.
- No admission-time (POST /pods) rejection on the daemon: scheduled jobs,
  watchers, series keep current behavior. The new pre-admission refusal is in the
  CLI `ap run` path only.
- No desktop (Swift) or mobile-web UI changes. Mobile/desktop reruns inherit the
  branch fix automatically via the template.
- No legacy (non-composable) rerun branch change (`dispatchRerunRequest`) —
  legacy pods don't record whether a branch was requested.
- No DB migration.

## Implementation Approach

Extract the read-only conflict collection from `inspect()` into a shared helper
used by both `inspect()` and a new `preview()` method, add an assessment pass,
expose `preview()` through a new `POST /launch/dispatch-preview` route that
resolves the request exactly like `/launch/resolve`, and wire the CLI.

## Phase 1: Ledger conflict assessment, read-only preview, guard message

### Changes Required

#### 1. Shared type
**File:** `packages/shared/src/types/dispatch-preflight.ts`
- Add `DispatchConflictAssessment { classification: 'active' | 'stale'; reasons: string[] }`
  and optional `assessment?` on `DispatchPreflightEvidence['conflicts'][number]`
  (export a named `DispatchConflict` type).
- Add `DispatchPreview { status: 'clear' | 'review_required' | 'authorized' | 'not_applicable';
  repository: string | null; baseBranch: string | null; workHash: string | null;
  conflicts: DispatchConflict[]; suggestedActions: string[] }`.
- Export from the shared index as needed.

#### 2. Ledger
**File:** `packages/daemon/src/pods/dispatch-preflight-ledger.ts`
- Factor the receipt + legacy candidate loops into
  `collectConflicts({ repository, baseBranch, workHash, legacyWorkHash, taskId, task, rowNumber?, repairPr })`
  (no writes). `inspect()` calls it unchanged in semantics (repair-stub generic
  scan stays inside `inspect`).
- `assessConflict(podId)` reads the live pod row columns listed above and returns
  the assessment; applied to every conflict in both `inspect()` and `preview()`.
- New `preview({ repository: rawRepoUrl, baseBranch, task, contract, intentionalRerun? }): DispatchPreview`
  — computes identity/hash with the same `canonical`/`hash` helpers (contract
  normalized via JSON round-trip), uses `taskId` sentinel that matches nothing
  and `rowNumber = +Infinity` equivalent (`Number.MAX_SAFE_INTEGER`) for legacy scan,
  never inserts. `authorized` when `intentionalRerun.ofPodId` resolves to the
  single conflicting pod (mirrors `inspect`'s direct-source rule).
- `suggestedActions(conflicts)` builds the human text:
  `ap kill <id>` (for each) and
  `ap run … --rerun-of <id> --rerun-reason "<why>"` (single conflict) —
  also used by the provisioning message.
- Add `preview` to the `DispatchPreflightLedger` interface.

#### 3. Guard message
**File:** `packages/daemon/src/pods/provisioning-workspace.ts:480-485`
- Message: `Equivalent active work requires review: <id> (<status>, <stale|active>: <reasons>)… Fix: <suggested actions>; or ap rerun <thisPod> --reason "…"`.
  Code/status unchanged.

### Success Criteria
#### Automated Verification
- [ ] New ledger tests (`dispatch-preflight-ledger.test.ts` or a new
  `dispatch-equivalent-work-preview.test.ts`): paused pod with zero changes →
  conflict with `assessment.classification === 'stale'` and still
  `review_required`; same pod with `filesChanged > 0` (or running status) →
  `active`; `preview()` reports the conflict and writes no row
  (`SELECT count(*) FROM execution_dispatch_preflights` unchanged); preview with
  `intentionalRerun.ofPodId` = conflicting pod → `authorized`.
- [ ] Existing dispatch tests pass: `npx pnpm --filter @autopod/daemon exec vitest run src/pods/dispatch`.

## Phase 2: Preview route + CLI preview/run reporting and `--rerun-of`

### Changes Required
#### 1. Daemon route
**File:** `packages/daemon/src/api/routes/configuration.ts`
- `POST /launch/dispatch-preview`: `resolveLaunch(body)` then, if repository is
  null or workflow is interactive/`skipAgent`-like (mirror guard skips:
  `agentMode === 'interactive'`) → `not_applicable`; else
  `deps.dispatchPreview?.(…)` (injected from `podRepo.dispatchPreflight.preview`).
  503 when unavailable. No writes.
- Wire the dependency where configuration routes are registered (`server.ts`).

#### 2. CLI
**Files:** `packages/cli/src/api/client.ts`, `packages/cli/src/commands/launch.ts`
- `client.previewDispatch(request)`; 404 → `null` (old daemon; print a one-line
  "equivalent-work check unavailable" note on preview).
- `--rerun-of <podId>` and `--rerun-reason <text>` options (both or neither;
  resolves the pod id; sets `work.intentionalRerun = { ofPodId, reason, requestKey: requestId }`
  and fixes `requestId` up front so preview/launch share it).
- Preview: print report; `process.exitCode = 2` when `review_required`.
- Launch (fresh, non-saved): if `review_required`, throw with the report and
  fixes before saving/launching.
- `ap dispatch-preflight` prints `assessment`.

### Success Criteria
#### Automated Verification
- [ ] Route test (`app.inject`): preview of a launch duplicating a paused,
  unproductive pod returns `review_required` with a stale conflict and suggested
  actions; no receipt row written.
- [ ] CLI tests (`launch.test.ts`): `--preview` with a conflicting dispatch
  preview prints the conflict + fix and sets exit code 2; `ap run` refuses to
  call `launchPod`; `--rerun-of/--rerun-reason` sets `work.intentionalRerun` and
  launches; 404 tolerated.
- [ ] `npx pnpm --filter @autopod/cli test`.

## Phase 3: Rerun keeps the requested branch

### Changes Required
**File:** `packages/daemon/src/api/routes/pods.ts` (composable template branch)
- Include `branch: source.work.branch` when set, not equal to the effective base
  branch, and no pod from `podRepo.listNonTerminal()` other than the source with
  `status !== 'failed'`… (exact: any non-terminal pod, excluding the rerun source
  itself, whose `branch` equals it). Otherwise omit (admission auto-names).
- Extract as a small helper `rerunBranch(source, pods)` returning
  `{ branch?: string; heldBy?: string[] }` for testability.

**File:** `packages/cli/src/commands/pod.ts` (`ap rerun`)
- Read the source's requested branch from `getPodLaunchConfiguration(source)`
  (best effort); after launch, if requested and `pod.branch !== requested`, print
  `Requested branch '<b>' is held by another active pod; rerun uses '<pod.branch>'.`
  Otherwise print the branch in the success line.

### Success Criteria
#### Automated Verification
- [ ] Daemon test (extend the rerun-template test near `pod-manager.test.ts:11945`
  or a new focused test): template keeps `work.branch` when free; omits it when
  another active pod holds it; the resulting rerun pod has the requested branch /
  `${prefix}<id>` respectively.
- [ ] CLI `pod.test.ts`: fallback message printed when branches differ.

## Final checks
- `npx pnpm --filter @autopod/shared build`, daemon + CLI `typecheck`
  (`npx pnpm --filter @autopod/daemon exec tsc --noEmit`, same for cli), `npx pnpm lint`,
  affected test files, then `npx pnpm build` if time allows.

## Testing Strategy — Manual
1. On a daemon with a paused, change-free pod A: `ap run <same spec> --preview` →
   conflict listed as stale with fixes, exit 2.
2. `ap run <same spec> --rerun-of A --rerun-reason "relaunch after #646"` →
   pod admitted and passes provisioning; `ap dispatch-preflight <B>` shows
   `admitted` + rerun intent.
3. `ap rerun <failedPod> --reason …` keeps its requested branch.
4. Desktop/mobile rerun shows the requested branch (Mac/human check).

## Migration Notes
None (optional JSON field; new route; old daemons → CLI tolerates 404).

## References
- Research: `thoughts/shared/research/2026-11-22-647-equivalent-work-guard.md`
