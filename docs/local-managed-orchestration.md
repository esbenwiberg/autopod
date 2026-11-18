# Local managed orchestration

This internal, opt-in host composition lets a controller commission workers, yield for **N new results**, and plan another wave before the rest finish. SQLite owns the decisions and reservations. A controller reply is a proposal, not permission to choose a grant, accept code, or publish it. The normal daemon entry point provisions one operator slot only when explicitly enrolled. Omission keeps the feature off.

## Reproduce the overlapping waves

In the prepared worktree, with daemon dependencies installed:

```sh
cd packages/daemon
./node_modules/.bin/vitest run src/orchestration/continuations.test.ts -t 'controller commissions six'
```

Both cases use private Git, on-disk SQLite, an offline SDK transport, and owned Node child processes. One controller turn proposes six briefs and waits for three results. On the third report a second turn proposes two follow-ups, then hands control back. The assertions check **eight children, five live PIDs (including the same three unfinished originals), two controller calls, and no remaining request allowance**. Duplicate notifications do not change those counts. The startup case disconnects the listener before the third return and reopens SQLite before reattaching it.

## Docker restart canary (opt-in)

From `packages/daemon`, use a **local** Docker socket and a pre-existing Alpine image. No image pull, external provider, credentials, published ports or network access in the workers is needed.

```sh
AUTOPOD_MANAGED_DOCKER_SOCKET=/absolute/path/to/docker.sock \
AUTOPOD_WAVE_DOCKER_IMAGE="$(docker image inspect alpine:3 --format '{{.Id}}')" \
./node_modules/.bin/vitest run src/orchestration/waves.docker.test.ts
```

The first scheduler launches six workers against read-only synthetic source. Three write reports and exit on an explicit FIFO barrier. After the follow-up decision and reservations commit, the test sends the scheduler itself SIGKILL before wake acknowledgement. A different scheduler process restores from SQLite and uses Docker's persisted container IDs. The canary checks eight distinct containers, five running (including the three original survivors), two offline controller requests total, 16 worker request reservations and no refund. It cancels, verifies Docker and the ledger both report exit, and removes only containers carrying the test's random ownership label.

This uses a fixed Docker workload through a test runtime port. It is not the packaged Codex worker, a real model, the full HTTP daemon or hosted startup. See [managed local Docker](managed-local-docker.md) for the separate production-runtime tests.

## Credential-owning daemon: one-shot hosted-model canary

This branch has an opt-in **synthetic test**, not a rollout switch. On a compatible daemon build the operator can set `AUTOPOD_REPOFIT_WAVE_CANARY=1`, an absolute `AUTOPOD_MANAGED_DOCKER_SOCKET` and an already-installed Alpine image ID in `AUTOPOD_WAVE_DOCKER_IMAGE`. The daemon must have Docker CLI access to that engine and local bind mounts. It checks the reviewed repofit profile revision 2, AI revision 8 and hosted Anthropic Pro main account/model. Only provider binding is reused. No profile repository, workflows, external tools, failover, developer credentials, or local models are used.

The daemon attempts at most two Messages requests (512 output tokens each, 8 KiB request body limit, no retries). It checks six initial workers, three real reports, separate MAPLE and IRIS follow-ups and none for clean CEDAR. A private directory `<DB_PATH>.repofit-wave-v1` holds the synthetic ledger and Docker ownership label. Its exclusive creation prevents a restart from spending again; do not delete it to retry. After interruption, inspect the retained ledger and matching containers; timeout or a missing reply is not proof of zero usage. The regular Docker crash test separately covers scheduler restart.

**Release boundary:** this branch incorporates `62a2031f` and preserves released migrations 255 (validation timings) and 256 (immutable fresh handoff preparations). The seven original unpublished orchestration scripts occupy 262–268 with unchanged SQL. Migration 269 records operator ownership independently of retained checkpoint bytes; 257–261 are intentionally unused. A spike or mixed-lineage database is refused, not automatically renumbered or replayed. Keep such a database with its original binary. `src/db/orchestration-release-upgrade.test.ts` uses a verified online backup of synthetic release-255 and release-256 databases, migrates only a restored copy, and checks preserved evidence, uncertain request accounting, reopen and integrity. This is not a backup or upgrade of the running service. Before rollout, repeat verification on an authorized backup of the intended database and obtain independent release review. The released binary has no canary entry point; the local Docker integration uses a stubbed hosted response, not a live model.

## Operator lifecycle (opt-in server composition)

With `AUTOPOD_OPERATOR_ENROLLMENT` configured, a registered operator can POST `/orchestration/runs/:slot/start`, GET `.../status`, POST `.../cancel`, or POST `.../fence`. The host must first provision the run envelope, verified checkpoint, recipe catalog, controller policy and client. A slot belongs to an exact issuer/audience/object binding, not everyone in an installation. Start accepts no overrides. Status includes request balance, children, observed exits and inspectable unknown outcomes. Fence takes only an inspected `kind`, `key`, `binding` and a `caseRef`; the daemon supplies the actor and run. Cancel requests stops; it does not claim that workers have exited. After all exits are observed, POST `.../cleanup` removes the run’s containers and networks using replayable managed cleanup operations.

Boot takes an OS-released owner lock next to the canonical SQLite file before accepting requests, and reattaches only previously started, uncanceled slots. Do not remove owner lock files from a running installation. The operator route tests use Fastify injection, deterministic provider replies, and persistent SQLite. They cover restart, unauthorized access, replay, and refusal while a separate process holds the owner lock. The packaged-worker test below separately kills the entire isolated HTTP server process, not just the controller.

**Provisioning.** Use the daemon's reviewed local `AUTOPOD_MANAGED_PROFILE_SET` and Entra `AUTOPOD_MANAGED_CLI` bindings; no dev auth, mock Docker, catalog expansion or simultaneous one-shot canary. The JSON schema in `src/orchestration/operator-enrollment.ts` accepts one version-1 slot: the bound object ID, mission, exact existing profile/AI revisions and main account/model, request/concurrency/worker/turn limits, approved read-only report recipe requests, source Git identities and bundle checksum, and two distinct evaluator public-key/configuration pins with signed receipts. Keep all configuration in daemon-owned storage outside worker mounts. No secrets or private signing keys belong in the envelope. Each independent evaluator signs a passed gate statement for `operatorSeedInput` only after its own evaluation. Use `operatorBasePolicy`, `combinedPolicyDigest` and `operatorRunId` to compute the bindings. Never use test signers in a deployment. A new key/configuration requires a new reviewed enrollment; it cannot rewrite an existing run.

The first boot verifies the exact seed file and retains the checked Git bundle; restart uses verified SQLite custody and does not require the import file. Packaged workers clone independent workspaces from the restored private mirror. The report operator path deliberately has **no** code acceptance or publication operation. A changed policy or stale signature is refused before attaching channels. Start uses a maximum of two hosted main-route turns, eight children, 512 output tokens per turn and an 8 KiB wire body. Worker budgets are separate. These are ceilings, not authorization to invoke a model on a live host.

**Disable/rollback.** Cancel through the authenticated slot, inspect unknown outcomes (never make up an exit), wait for observed exits, then request and verify cleanup. Removing the enrollment with outstanding owned work is refused. Keep SQLite, backups and one-shot markers. Do not run the older release against a migrated live DB or restore a stale snapshot over newer work.

**Reproduce** from `packages/daemon`: use the immutable packaged image and local socket from [managed local Docker](managed-local-docker.md), then run `./node_modules/.bin/vitest run src/orchestration/operator-packaged.docker.test.ts`. This uses the ordinary HTTP server, production enrollment and Codex profile composition, disposable SQLite, actual Docker and installed Codex. The operator token validator and both model transports are fixtures. Six start, three report; the process receives SIGKILL after committing the two follow-ups and before acknowledging the wake. Its successor starts only the two committed follow-ups. The assertions check all eight immutable container IDs, five live worker processes including the three original PIDs/start times, request balance, observed exits and replayable cleanup. Retained supervisor containers alone are **not** counted as live workers. This is not an Entra login, hosted inference or production deployment.

## Host lifecycle

1. Construct `LocalCheckpointHost` with a private scratch directory and a host-owned managed-service factory. Open a run and retain a verified starting commit. Set the whole-run request allowance and concurrent worker limit separately. For the example, eight worker reservations of two requests plus two controller requests cost 18; six slots suffice.
2. `await host.ledger.kickoff(checkpoint, { inspect: approvedTemplate })` preflights the template and commits the accepted starting checkpoint, catalog and first wait atomically. It launches no placeholder. Exact replay is harmless; a changed catalog is not a replay.
3. Attach `host.watchController(run, { mission, routeId, recipes: { inspect: '@inspect' }, findings: 'report.md' }, approvedClient)`. The host supplies the client and recipe bindings. Report text is opt-in. The kickoff has zero results. Subsequent turns see scoped results, capacity and bounded lists of stable child keys. The controller replies with `{children: [{recipe, brief}], waitFor}`. `waitFor: null` hands control back to the host; it neither cancels existing workers nor approves delivery.
4. Keep normal managed runtime observation and artifact collection running. An observed exit frees a slot; the completed artifact/candidate or terminal failure makes a result available. These events, new intents and newly parked waits signal the owner. The controller does not poll. `await loop.settled()` joins already-signaled work and reports blocked intents or errors; it does **not** trigger work or wait for outstanding workers.
5. `await loop.close()` before closing the database. This detaches and drains, not cancels. After restart, attach again with the same frozen policy and client: subscription precedes the initial SQLite catch-up. Live signals require producers and listener in the **same process using the same DB connection**. Notifications are hints, not a durable cross-process bus. Use one active local owner. Moving ownership requires reattachment/catch-up.

## Safety and recovery

- Wakes are at-least-once. A recorded decision replays with the same worker keys and reservations. A missing provider reply is not permission for another request. For crash tests run `continuations.test.ts -t 'SIGKILLed scheduler'` with Vitest.
- Inspect uncertainty with `host.interventions.inspect(run)`. A trusted operator may call `fence(target, actor, caseRef)` on an inspected target. This irreversibly stops new work for the **whole run**, records the action and preserves the charge. An unanswered allocation is not evidence of exit.
- Findings don't accept code. Report-based children keep the host-approved checkpoint. For a two-worker source integration, `retainCombined` checks the run-owned parents and exact clean tree and verifies separate policy-pinned signatures. `acceptAndContinue` admits a child pinned to that commit. See `src/managed/checkpoint-handoff.test.ts`.
- This is a local orchestration proof, not a production sandbox or rollout. The tests do not require provider credentials, publish intermediate refs or create a PR. Cross-host election/event delivery, production evaluator operations and publication are outside this report-run endpoint.
