---
date: 2026-10-15
researcher: Codex
branch: codex/reliability
repository: autopod
topic: "Availability of an isolated real-pod validation path"
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Live validation availability

## Executed read-only discovery

Agent research_cli probed the environment while integration advanced from
2ff947ea to2c23df03. No dispatch, deployment, credential refresh, provider request,
live-data mutation or tracked write occurred.

- Docker version probe timed out at eight seconds; selected context desktop-linux.
- Configured hosted /health responded200/ok, release
  cfb1c81c0fb9a07d11da9330c6890213dec912ab. This is not campaign code.
- CLI credential files exist, but neither cached candidate was unexpired. No
  authenticated catalog read was attempted. Secret values were not printed.
- Azure account metadata lookup succeeded; enabled subscription matches repository
  documentation. This does not establish sandbox data-plane access or a campaign
  provider/repository binding.
- Azure subscription/resource-group process variables and seven managed live-test
  or profile-set variables were absent. Bounded filename inspection found no
  candidate binding files in the known local Autopod locations; this does not
  prove absence elsewhere.

No isolated real-pod path is currently verified usable for this campaign revision.
Standing authorization remains; deployment to the hosted daemon is outside scope.

## Existing paths and boundaries

- docs/managed-local-docker.md:99 documents canary image/auth/model/repository inputs.
- packages/daemon/src/managed/live-rpi.docker.test.ts:59 skips without four explicit
  inputs. It mirrors a supplied repository's main into a temporary local bare
  remote; it does not automatically select this campaign branch (:68–80).
- Each of three stages permits20 provider requests,500,000 observed tokens and
 480 seconds; grants expire after30 minutes, total test timeout25 minutes. Token
  accounting is not a prepaid monetary cap. One64-KiB artifact per stage. See
  live-rpi.docker.test.ts:69,108,125,207,420 and test-utils/managed-fixture.ts:133.
- The canary verifies denied external egress, worker capabilities and an independent
  source-bundle behavior oracle. Finally stops runtimes, removes containers with
  Docker404 assertion, removes networks and owned filesystem/DB/server resources.
  Some early setup and early teardown failure paths lack an outer cleanup guard.
  This is fixture authentication/component execution, not hosted Entra/bootstrap.
- managed/profile-set-config.ts:130 and managed/cli-config.ts:31 require exact
  repository revision/enrollment, target/image/budget and installation identity.
  A generic Azure account/profile is not the same binding.
- scripts/docker-validate.sh:69 starts a docker-run container, whereas its cleanup
  uses Compose down (:44). It does not explicitly remove that run container.
  docker-validate.sh:119 and smoke-test.sh:90 use literal dev-token without the
  current explicit AUTOPOD_ALLOW_DEV_AUTH flag; index.ts:318 generates/reads a
  random token only when that flag is enabled. These scripts test health/profile
  operations, not actual agent execution; per-call deadlines are also absent.
- scripts/smoke-sandbox-adapter.mjs requires subscription/group/image, defaults
  to tierL, invokes no model and removes its sandbox/tempdir in finally. It lacks
  a whole-script deadline and independent deletion confirmation. Adapter kill
  delegates destroy and tolerates not-found (sandbox-container-manager.ts:353).

## Exact remaining proof boundary

A usable real test needs responding Docker or proven sandbox access, an immutable
reviewed worker image, exact provider/account/model binding, enrolled canary
repository/revision and bounded request/time configuration. It must execute the
campaign source without replacing the hosted daemon. Public health or available
Azure subscription alone cannot establish those facts. Existing deterministic
CLI, native composition, SQLite and process-crash proofs remain separately valid.

## Next action

Resolve infrastructure availability and inspect exact existing bindings before
any live dispatch. Do not call the campaign real-pod validated or silently test
another deployed revision. Smoke-script ownership/auth findings require their
own reproduction and plan before editing.
