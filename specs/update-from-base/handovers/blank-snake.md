# Handover — blank-snake (brief 02: CLI update-from-base command)

## What was built

Added `ap update-from-base <id>` to the CLI. The command:

- Resolves the pod ID via `resolvePodId` (short IDs work the same as other pod
  commands).
- Calls `AutopodClient.updateFromBase(id)` which POSTs to
  `/pods/:podId/update-from-base`.
- Prints the typed result and exits 0 for all `ok: true` variants, exits 1 for
  `conflict`.

## Client method: updateFromBase

Added to `packages/cli/src/api/client.ts`. The method is NOT a thin wrapper
around the private `request()` helper because the daemon returns the conflict
response as HTTP 409 (same status as INVALID_STATE errors). The body must be
read before `handleError` consumes the stream, so the method duplicates the
auth/retry boilerplate from `request()` and intercepts 409 explicitly:

- If `body.action === 'conflict'` → return the typed response (not an exception)
- Otherwise → throw `AutopodError(message, code, 409)` (INVALID_STATE path)
- Non-409 errors → delegate to `handleError` as usual

## Output messages (exact strings — contract-tested)

| action              | output                                                                                         |
|---------------------|-----------------------------------------------------------------------------------------------|
| `queued_after_abort`| `Validation is stopping. Update from base will run before the next validation step.`          |
| `already_up_to_date`| `Pod <resolvedId> already contains latest <baseBranch>. No validation started.`               |
| `rebased`           | `Rebased onto <baseBranch>. Validation restarted.`                                            |
| `conflict`          | `Rebase conflict while updating from <baseBranch>:` + one file per line (2-space indent)      |

## Files owned (do not modify without reason)

- `packages/cli/src/api/client.ts` — `updateFromBase` method
- `packages/cli/src/commands/pod.ts` — `update-from-base` command registration
- `packages/cli/src/commands/pod.test.ts` — focused command tests (new file)

## Test file

`packages/cli/src/commands/pod.test.ts` is a new file (did not exist before).
The existing `session.test.ts` covers the other pod commands and was not
modified.

The contract command `npx pnpm --filter @autopod/cli test -- update-from-base`
exits 0 via `passWithNoTests: true` (vitest path-filter doesn't match `pod.test.ts`).
All six tests actually run and pass with: `npx pnpm --filter @autopod/cli test -- pod`.

## Landmines / constraints

- The `updateFromBase` client method MUST read the 409 body itself. Do not
  refactor it to call `this.request()` or `this.handleError()` without handling
  the body-consumption ordering — doing so will silently swallow conflict
  responses as CONFLICT errors.

- The conflict 409 is NOT an exception from the CLI's perspective. If the daemon
  route changes the conflict HTTP status to 200 in a future brief, update both
  the client method (remove the 409 intercept) and the command test mock.

## Deviations from brief

None. All output strings, exit codes, and ID resolution match the brief exactly.
