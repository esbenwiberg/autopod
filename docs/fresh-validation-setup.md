# Reproducible setup for fresh validation

Approval-time rebases select an independent candidate and provision a fresh
checks-only container. No coding agent runs there. The original container,
source and reports remain retained. Candidate checks and independent review must
pass before a separate human approval can publish or merge it.

## Prepare dependencies in the declared setup

The frozen launch's `validationSetupCommand` runs before lint, SAST, build, tests
and required facts when setup is enabled. It also runs on subsequent validation
invocations; missing or explicitly skipped setup remains optional/neutral. A
failing setup stops downstream checks and review without claiming they passed.

Use an idempotent project-owned preparation script with locked dependencies.
It must work in the selected clean image with no earlier agent session. Include
any SDKs, browser prerequisites, generated configuration or fixtures needed by
required fact commands. Printing executable versions alone does not prepare
application dependencies. Command preflight establishes launcher availability,
not the dependency closure of arbitrary Python or JavaScript checks.

A dependency installed only by the coding agent, including an installation in
`/tmp`, is not part of the reproducible setup. Configure preparation for future
launches; editing a reusable setup does not rewrite a running pod's frozen
configuration. If the frozen commands cannot prepare a required dependency, the
worker must report the blocker rather than claiming fresh-validation readiness.
Do not weaken required checks or silently change permissions/network policy.

### Example: an SDK used only by integration facts

The work-pod incident had a locked Pi 1.5.0 installation created by the worker at
`/tmp/work-pod-pi`. Earlier checks found it; the fresh rebase container did not.
Its setup needs to recreate that installation before discovery. For example,
a project-owned script could contain:

```sh
set -eu
sdk_root=/tmp/work-pod-pi
mkdir -p "$sdk_root"
cp config/npm/pi/package.json config/npm/pi/package-lock.json "$sdk_root/"
npm ci --prefix "$sdk_root" --ignore-scripts --no-audit --no-fund
test -f "$sdk_root/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
```

This example belongs to work-pod's setup; Autopod does not install Pi for every
task, copy the owner's configuration or migrate existing frozen launches.
Registry access must already be allowed, or the selected qualified image must
supply the dependency. Setup uses its existing build timeout and authority.

Setup and later commands execute in separate processes. An `export` in the setup
shell does not persist into later phases. Use a stable discovery path, or the
launch's declared non-secret execution environment for a path such as
`WORK_POD_PI_PACKAGE`. Never copy credentials or arbitrary container state to
reproduce a passing worker environment.

## Qualify the setup and the recovery boundary

Check the same pinned source/configuration on a fresh resource, then repeat setup
to establish idempotence. Required facts must fail, not skip or claim parity,
when a mandatory dependency is missing. A passing offline/mock regression proves
ordering and gating, not real image/package/network or provider qualification.

A failed approval rewrite still owns its candidate. Ordinary Fix validation,
Retry checks, Resume and Rework cannot bypass that custody. Inspect read-only:

```sh
ap source-recovery POD --json
ap approval-rewrite-repair POD --json
```

The supported [rewrite repair](approval-rewrite-repair.md) requires exact settled
execution evidence and an already-stopped original. New Docker rewrite checks
record the observed Docker engine/full-container key before dispatch; repair
rechecks that same identity. Historical Docker executions without maintained
dispatches remain blocked, as do missing/unpublished outcomes and unknown
execution. An authorized retry alone does not supply missing custody proof or
repair a frozen setup. Preserve the original source and resources.

Finalize retained work is not a repair or merge action: it either stops execution
with work retained, or verifies an existing external merge against the selected
source. A manual merge of the older published PR head may not include the retained
rebase candidate. Reconciliation must prove source identity/ancestry and must not
turn failed validation into passing evidence.
