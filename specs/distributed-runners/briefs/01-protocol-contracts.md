# Brief 01: Runner protocol contracts

## Objective

Define the shared wire protocol, runner identity types, and placement type
in `@autopod/shared`. Everything downstream consumes these — must land
first so daemon + runner briefs can proceed in parallel.

## Dependencies

None.

## Blocked By

None.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/shared/src/types/runner.ts` | create | `RunnerIdentity`, `RunnerCapabilities`, `RunnerRecord`, protocol message unions |
| `packages/shared/src/types/placement.ts` | create | `Placement` discriminated union (see contracts.md) |
| `packages/shared/src/constants.ts` | modify | Add `RUNNER_PROTOCOL_VERSION = 1`, `RUNNER_DEFAULT_MCP_PORT = 7789`, `RUNNER_DEFAULT_HEARTBEAT_SECONDS = 10` |
| `packages/shared/src/index.ts` | modify | Append exports for the two new files |

## Interface Contracts

This brief produces the contracts in `contracts.md`:
- `RunnerIdentity`, `RunnerCapabilities`, `RunnerRecord`
- `Placement` union
- `RunnerToDaemon` + `DaemonToRunner` discriminated unions (the `hello`
  message must include `mcpPort: number` — the port on the runner's
  loopback the container dials for MCP; see Brief 08)
- `ContainerSpawnConfig`, `ExecResult`, `ExecOptions` re-exported from the
  existing `@autopod/daemon/src/interfaces/container-manager.ts` shapes —
  but since those currently live in the daemon package, move the ones that
  cross the wire into shared. Specifically move `ContainerSpawnConfig`,
  `ExecOptions`, `ExecResult` into `packages/shared/src/types/container-protocol.ts`
  and re-export from the daemon interface file.

## Implementation Notes

- Keep the discriminated unions with `type` fields — matches the existing
  `AgentEvent` pattern in `packages/shared/src/types/runtime.ts`.
- All message IDs are strings (UUIDs). Don't introduce a dependency for
  generation — shared should stay zero-dep. Generator function goes in
  brief 06 (runner side) and existing `nanoid` usage in the daemon.
- Export a `isRunnerToDaemon(msg)` type guard.
- Don't add runtime validators (no Zod) in shared — validators live in
  daemon/runner consumers.

## Acceptance Criteria

- [ ] `RunnerIdentity`, `RunnerCapabilities`, `RunnerRecord` types exported
  from shared.
- [ ] `Placement` discriminated union exported from shared.
- [ ] `RunnerToDaemon` and `DaemonToRunner` message unions exported with
  `type` discriminators.
- [ ] `ContainerSpawnConfig`, `ExecOptions`, `ExecResult` moved to shared
  and re-exported by `packages/daemon/src/interfaces/container-manager.ts`.
- [ ] `RUNNER_PROTOCOL_VERSION`, `RUNNER_DEFAULT_MCP_PORT`,
  `RUNNER_DEFAULT_HEARTBEAT_SECONDS` exported from
  `packages/shared/src/constants.ts`.
- [ ] Daemon package builds cleanly after the move (imports updated).
- [ ] No new runtime dependencies added to `@autopod/shared` (zero-dep rule
  preserved).
- [ ] Co-located `runner.test.ts` asserts message union exhaustiveness via
  a `never` check on the discriminator.

## Estimated Scope

Files: 4 modified/created + downstream import fixes | Complexity: low
