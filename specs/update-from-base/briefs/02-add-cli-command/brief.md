---
title: "Add CLI update-from-base command"
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

```bash
ap update-from-base <id>
```

The command should resolve the pod ID using the same helper as other pod
commands, call `POST /pods/:podId/update-from-base`, print the typed result,
and exit non-zero only for conflict or request errors.

Add `updateFromBase(id: string): Promise<UpdateFromBaseResponse>` to
`AutopodClient`. Use the shared response type exported by brief 01.

Command output:

- `queued_after_abort`: `Validation is stopping. Update from base will run before the next validation step.`
- `already_up_to_date`: `Pod <id> already contains latest <baseBranch>. No validation started.`
- `rebased`: `Rebased onto <baseBranch>. Validation restarted.`
- `conflict`: print `Rebase conflict while updating from <baseBranch>:` followed
  by one conflicted file per line, then exit 1.

## Touches

- `packages/cli/src/api/client.ts` - daemon client method.
- `packages/cli/src/commands/pod.ts` - Commander registration and output.
- `packages/cli/src/commands/pod.test.ts` - command tests. If the repo uses a
  differently named pod command test file, use that existing file instead.

## Does not touch

- `packages/daemon/` - daemon behaviour is owned by brief 01.
- `packages/shared/` - response contract is owned by brief 01.
- `packages/desktop/` - desktop UI is owned by brief 03.
- `packages/escalation-mcp/` - no agent/MCP path for this action.

## Constraints

- Follow `design.md` -> UX flows -> CLI for the output shape.
- Use `resolvePodId` so short IDs work the same way as existing commands.
- Preserve existing error handling from `AutopodClient`; do not swallow daemon
  `INVALID_STATE` errors.
- Conflict response is not an exception; it is a typed 200 response with
  `ok: false`. The CLI is responsible for turning that into exit 1.

## Test expectations

Add focused CLI tests that cover:

- command registration includes `update-from-base <id>`.
- short ID resolution is called.
- `rebased` prints the base branch and exits 0.
- `queued_after_abort` prints the queued message and exits 0.
- `already_up_to_date` prints that no validation started and exits 0.
- `conflict` prints all conflicted files and exits 1.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
