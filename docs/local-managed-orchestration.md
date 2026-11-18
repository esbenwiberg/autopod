# Local managed orchestration

This internal, opt-in host composition lets a controller commission workers, yield for **N new results**, and plan another wave before the rest finish. SQLite owns the decisions and reservations. A controller reply is a proposal, not permission to choose a grant, accept code, or publish it. There is no hosted startup switch or public endpoint.

## Reproduce the overlapping waves

In the prepared worktree, with daemon dependencies installed:

```sh
cd packages/daemon
./node_modules/.bin/vitest run src/orchestration/continuations.test.ts -t 'controller commissions six'
```

Both cases use private Git, on-disk SQLite, an offline SDK transport, and owned Node child processes. One controller turn proposes six briefs and waits for three results. On the third report a second turn proposes two follow-ups, then hands control back. The assertions check **eight children, five live PIDs (including the same three unfinished originals), two controller calls, and no remaining request allowance**. Duplicate notifications do not change those counts. The startup case disconnects the listener before the third return and reopens SQLite before reattaching it.

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
- This is a local orchestration proof, not a production sandbox or rollout. The tests do not require provider credentials, publish intermediate refs or create a PR. Hosted owner election/event delivery, isolated signing services, operator authentication and final human-approved publication need separate integration and verification.
