---
title: "Add CLI update-from-base command"
depends_on: [01-add-daemon-update-from-base-action]
acceptance_criteria:
  - type: cmd
    outcome: npx pnpm --filter @autopod/cli test -- update-from-base -> exit 0
    hint: npx pnpm --filter @autopod/cli test -- update-from-base
    polarity: exit-zero
touches:
  - packages/cli/src/api/client.ts
  - packages/cli/src/commands/pod.ts
  - packages/cli/src/commands/pod.test.ts
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/desktop/
  - packages/escalation-mcp/
---

## Task

Expose the daemon action as a terminal command:

```
ap update-from-base <id>
```

The command is intentionally small: resolve the pod ID using the same helper as
other pod commands, call the daemon route, print the typed result, and exit
non-zero only for conflict or request errors.

## API client

Add `updateFromBase(id: string): Promise<UpdateFromBaseResponse>` to
`AutopodClient`.

Endpoint:

```
POST /pods/:podId/update-from-base
```

Use the shared `UpdateFromBaseResponse` type from `@autopod/shared` once brief
01 exports it.

## Command

Register the command in `packages/cli/src/commands/pod.ts` near the other
pod-scoped actions.

Output:

- `queued_after_abort`:
  `Validation is stopping. Update from base will run before the next validation step.`
- `already_up_to_date`:
  `Pod <id> already contains latest <baseBranch>. No validation started.`
- `rebased`:
  `Rebased onto <baseBranch>. Validation restarted.`
- `conflict`:
  print `Rebase conflict while updating from <baseBranch>:` followed by one
  conflicted file per line, then `process.exit(1)`.

Use existing chalk/style helpers. Do not add JSON-output support unless the
surrounding pod action command pattern already requires it.

## Touches

- `packages/cli/src/api/client.ts` - daemon client method.
- `packages/cli/src/commands/pod.ts` - Commander registration and output.
- `packages/cli/src/commands/pod.test.ts` - command tests. If the repo uses a
  differently named pod command test file, use that existing file instead.

## Does not touch

- No daemon behaviour changes.
- No desktop changes.
- No changes to `ap revalidate` semantics.

## Constraints

- Use `resolvePodId` so short IDs work the same way as existing commands.
- Preserve existing error handling from `AutopodClient`; do not swallow daemon
  `INVALID_STATE` errors.
- Conflict response is not an exception; it is a typed 200 response with
  `ok: false`. The CLI is responsible for turning that into exit 1.

## Test Expectations

Add focused CLI tests that cover:

- command registration includes `update-from-base <id>`.
- short ID resolution is called.
- `rebased` prints the base branch and exits 0.
- `queued_after_abort` prints the queued message and exits 0.
- `already_up_to_date` prints that no validation started and exits 0.
- `conflict` prints all conflicted files and exits 1.

## Wrap-up

- Run the targeted CLI test named in the acceptance criteria.
- Include example CLI output in the handover.
