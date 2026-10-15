# R09: final campaign qualification

## Scope and authority

Close the finite reliability campaign after R04e and R04f. The user's standing
authority covers autonomous research, planning, verification and branch-contained
integration. This task changes documentation/evidence only. It adds no product
capability, deploys nothing and does not merge into main. Root owns the plan and
final verdict; a separate reviewer checks accounting and final source coverage.

Research: thoughts/shared/research/2026-10-15-campaign-final-qualification.md.
There are no unresolved product choices. Automated native inspection is recorded
as agent-operated evidence, never human signoff.

## Phase 1: complete existing gates

Finish R04e and R04f exactly under their own plans: independent review before PR,
hosted general/native checks, merge into campaign, and affected integrated proof.
Preserve baseline and final evidence, source revision and material limits. Reuse
existing managed worktrees. Clean only finished Swift build caches with the Swift
package command after proof is retained; keep at most two full caches. Serialize
native runs. No new live resources are required for desktop-only final changes.

## Phase 2: combined verification

Record clean campaign HEAD, remote branch/main references and toolchain. Check
whether main has moved since9978fb5e; integrate any relevant intervening main
change at a separate checkpoint with affected checks, rather than testing an
unknown mixed state. Preserve the user's original dirty checkout.

Use Node22/pnpm9.15.4. Run a separate frozen installation; stop and diagnose its
failure rather than allowing the script's regular-install fallback to change the
lockfile. Then execute scripts/validate.sh --quick with SKIP_DB_TESTS=0 and
TURBO_FORCE=true to include SQLite tests and bypass cached test evidence. Verify
the actual Turbo log reports forced execution; if it replays cache, run the
affected Turbo stage with its explicit `--force` option before counting it. Preserve
the full log, command, each stage's actual exit/outcome and skip counts. Inspect
failures; fix campaign regressions through scoped review and rerun only the checks
affected by the correction. A dependency-service failure is an unavailable audit,
not proof of clean dependencies; record exact output and existing hosted policy.
Do not upgrade the package manager or alter audit gating merely to obtain green.

The JavaScript pipeline may run while R04f changes only native sources, provided
root records a digest manifest for every tracked input except thoughts/ artifacts
and desktop .swift files, and proves those inputs unchanged at the final head.
This deliberately includes bundled renderer files, fixtures and runtime Markdown
templates rather than excluding files merely by a documentation-like extension.
If they change, rerun
the affected stage(s). Run final diff/secret scans again at the final source.

After final desktop integration, run the full serialized Swift suite and build
AutopodDesktopExe on the final campaign source. R04f's final native captures and
independent actual input/race reruns satisfy visual/interaction proof; do not
repeat every earlier screenshot when its implementation is unchanged. Account
for Swift Testing summary totals including disabled tests, expanded cases and
separate XCTest results. Retain the live-village skip as a limit.

Inspect the final affected PR's hosted general test/secret and Desktop test,
renderer contract and Xcode build results, tied to its exact head/merge refs.
Documentation-only final commits do not invalidate unchanged product evidence.
Record their relationship rather than claiming every source SHA was separately
built. Do not repeat prior cloud, migration/performance or SIGKILL experiments
when unchanged tested source and integrated suites already support the claims.

## Phase 3: evidence review and closure

Update the campaign ledger and this plan with exact integrated revisions and
check results. Keep task evidence under .autopod-data/reliability; add a concise
committed final report linking task RPI plans, task PRs and key receipts. An
independent agent checks final diff, test/skip accounting, no open task gates,
source-digest continuity, branch containment and remaining limits before closure.
Source hashes and logs support claims; test counts alone do not prove a journey.

Finish with the branch, concrete improvements, strongest evidence and material
limits. This establishes the scoped campaign, not universal reliability, complete
full-app acceptance, exactly-once replies or production rollout.

## Success criteria

- [x] R04e/R04f reviewed, hosted and integrated gates closed.
- [x] Frozen install and uncached combined JavaScript checks accounted for.
- [x] Final full Swift suite, executable and hosted Xcode proof accounted for.
- [x] Final source/digest continuity, skips, audit outcome and evidence reviewed.
- [x] Campaign report committed/pushed; main and original checkout preserved.

No manual preference check is necessary to establish these technical contracts.
If a new product choice or unsupported authority appears, root reports it instead
of quietly expanding the campaign.

## Execution adjustment: pinned toolchain

Expected: scripts/validate.sh --quick invoked inside the pinned npx environment
executes its six stages with Node22/pnpm9.15.4. Found: inherited npm_config_call
first caused nested npx EUSAGE before any checks. Removing that inherited option
allowed the script to run, but its nested npx selected the system pnpm/Node24;
the actual daemon run rejected Node22 SQLite ABI127 because Node24 requires137.
The script exited1, with2522 failed daemon cases; this is retained as failed
execution, not counted as passing validation. Rebuilding SQLite under the wrong
runtime would obscure the required environment.

Adjustment: execute the exact six stages in order through direct pinned pnpm
subprocesses from an ignored Python runner, preserving each exit, failure
aggregation and the original all-dependencies audit arguments. Frozen install
already passed separately with the intended versions. The runner asserts Node22
and pnpm9.15.4 before work. Independent reviewer checked its equivalence, all4417
input hashes, failed logs and observed forced build execution; no blocking issue.
No product/script source changed. Failed logs remain validate-wrapper-failure.*
and validate-node24.*. The current valid invocation is:

```sh
NODE_ENV=development SKIP_DB_TESTS=0 TURBO_FORCE=true \
  npx -y -p node@22 -p pnpm@9.15.4 \
  -c 'python3 .autopod-data/reliability/final/validate-pinned.py'
```

checks.json and separate stage logs record actual results. Final source continuity
and final secret scan still apply; completed stages are not yet whole-campaign
closure.

## Final combined result — October 16

Technical qualification is PROVEN at integrated source `f587fa075965245e53049b7367cb317eb8a0c55b`.
R04f PR436 passed independent review, the corrected hosted Swift6.1.2/full Xcode
workflow and general CI before integration. Root then ran the complete serialized
Swift suite on integration:495 functions /651 executions /27 suites passed,
13 XCTest cases passed separately, and one existing live-daemon function/suite
was skipped. The executable build and final secret scan passed. Root inspected
all43 freshly generated native captures; actual-sheet raster limitations remain
qualified by identical-production-content captures and actual interaction tests.

All4417 JavaScript inputs match the uncached passing pipeline, including exact
tracked membership. All23 R04f correction source hashes matched before these
closure-document edits. Main remains9978fb5e; original dirty checkout was not
modified by this campaign. Final evidence is in final/proof.json, continuity.json,
js-proof.json, swift.log, executable.log and native capture directories.

Earlier sandbox and fleet experiments remain tied to their measured snapshots.
Final audit found the sandbox broad-input manifest differs in one runtime Zod
schema after main integration; the fleet broad manifest includes later managed
changes and two new managed-only migrations. No final-head live-bundle identity
or final-head timing claim is made. Current combined tests establish tested
compatibility. See the final report for exact scope and retained failures.

Final independent closure review found no actionable findings:94 evidence hashes,
4417 JavaScript inputs/membership,23 R04f source hashes against tested HEAD, raw
counts/skips, hosted-source equivalence, earlier task gates and branch containment
all verified. Closure report is committed with this plan at
`2026-10-16-reliability-final-report.md`. All selected gates are complete; no further
product work or experiment is implied. Final document commit is pushed to the
campaign branch only.
