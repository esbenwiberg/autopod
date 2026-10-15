---
date: 2026-10-15T23:24:03+02:00
researcher: Codex
git_commit: f21d61fc8e72ac56ba6a72e2163ebb7502c80af9
branch: codex/reliability
repository: autopod
topic: Existing final campaign qualification commands and evidence boundaries
status: complete
---

# Campaign qualification boundaries

Root read scripts/validate.sh, package.json, turbo.json, daemon/vitest.config.ts,
the CI/Desktop workflows, the complete live-village test and campaign ledger.
This records the existing checks; no product code changes or new live run.

`scripts/validate.sh` runs install, lint, build, typecheck, tests, dependency audit
and secret scan, accumulating check failures. Its normal install falls back from
frozen to regular installation; `--quick` skips installation entirely. Smoke is
opt-in and targets a running daemon. Root package test includes Turbo package
tests plus Node script tests and hosted deployment/cleanup shell tests.

The repository pins pnpm9.15.4; hosted CI selects Node22. Turbo tests depend on
builds, but outputs may be served from its cache. The daemon Vitest config defaults
to four workers and detects SQLite by opening an in-memory database. Explicit
SKIP_DB_TESTS=0 forces inclusion instead of silent auto-exclusion. Docker/model
fixtures retain their own opt-in environment gates.

CI and Desktop workflows cover codex/reliability push/PR. Hosted general CI runs
frozen install, lint, build, typecheck and tests; dependency audit is explicitly
non-blocking with a comment describing pnpm9's retired npm audit endpoint. That
comment is historical evidence, not the result of a fresh local audit. Secret
scanning is a separate hosted job. Desktop runs serialized Swift tests, bundled
village renderer contract/asset checks, and an unsigned Xcode app build on macos15.

Native Swift packages are outside pnpm. The live-village test is disabled unless
AUTOPOD_LIVE_VILLAGE_TEST=1 and reads existing home credentials; it expects a real
nonempty fleet and exercises REST/WebSocket/WebKit. Default native success does
not mean that live test ran. The campaign's existing native proofs use actual
production views with private model/HTTP seams, and explicitly exclude full-app
account/bootstrap acceptance. R01c records separate bounded native sandbox proof,
including observed removal; it does not claim a model-powered end-to-end pod.

The campaign ledger records closed reviewed/hosted/integrated slices through
R06b/R07a. R04e is independently reviewed but not yet integrated; R04f has a strict
native failing baseline and awaits R04e. Prior evidence remains in each task's
ignored .autopod-data/reliability directory and its committed RPI plan. Root's
current main check still returns9978fb5e, already merged at checkpointa6c0c565.
The original user's checkout remains separate from the campaign worktree.

Local disk has2.6GiB available with two complete Swift caches. An earlier third
cache exhausted disk; completed caches were cleaned with Swift package commands
while retaining source and evidence. Native tests share a process/display and
the campaign has serialized those runs across workers. Local Swift6.3.3 and
hosted Swift6.1.2 differ; both are represented in existing task proof.

No unresolved current-source question blocks a bounded final qualification plan.
Final execution, audit availability and new skip/failure accounting are not yet
established by this research.
