# Distributed Runners — Plan

## Problem

Autopod today is a monolithic daemon: it owns the queue, the SQLite DB, and
the Docker socket that hosts every session's container. Two user needs push
against this:

1. **Heavy sessions want beefy hardware.** Large .NET + npm builds are
   CPU/memory hungry. Running them in ACI costs per minute and starts slowly;
   running them on the daemon host doesn't scale if the daemon lives on a Pi.
2. **Always-on daemon + sleep-prone laptop.** The orchestrator needs to live
   somewhere stable (Pi or Azure VM), but execution capacity should follow
   the user's hardware.

`executionTarget: 'local' | 'aci'` doesn't distinguish "local to the daemon"
from "local to the user's laptop."

## Goals

- Daemon runs unchanged on a **Pi** (cheap always-on, Tailscale-exposed) or a
  **small Azure VM** (Standard_B1s, ~$8–15/mo). Deployment is an ops choice,
  not a code choice.
- Sessions target one of:
  - `local-docker` — Docker socket on the daemon host (backwards compat)
  - `aci` — existing Azure Container Instances executor
  - `runner:<name>` — remote runner registered with the daemon (laptop today,
    Mac mini future)
- Target is a profile-level default, overridable per session. Targets never
  auto-reroute.
- Offline target → sessions queue indefinitely (no silent spill to ACI).
- Runner disconnect mid-session → new `runner_offline` state; reconcile on
  reconnect (resume if container alive, fail if container gone).
- Desktop app is the runner control center. No web UI.

## Approach

### Thin runner, proxied MCP

The runner is a **thin executor** — exposes the existing `ContainerManager`
interface plus workspace tar I/O and an MCP proxy over a single outbound
WebSocket connection to the daemon. Worktrees, git ops, PR creation, and
queue management stay on the daemon, untouched.

Containers dial the **runner's loopback** for MCP callbacks; the runner
tunnels those over its persistent daemon connection. Containers need no
route to the daemon directly — same network story for Pi or Azure daemon.

### Seam: `ContainerManager` + factory

The `ContainerManager` interface (`packages/daemon/src/interfaces/container-manager.ts`)
is already transport-agnostic. Adding a remote runner = a new
`RemoteContainerManager` that marshals calls over the WebSocket. The factory
in `packages/daemon/src/index.ts:269` already selects by `executionTarget` —
we extend the branching.

### Worktree lifecycle (tar-over-wire, daemon stays authoritative)

1. Daemon creates worktree on its disk (unchanged — same `LocalWorktreeManager`).
2. Before container spawn, daemon tars worktree and sends via the protocol's
   `workspace_upload` message.
3. Runner extracts into a local volume, bind-mounts into container.
4. Container runs; events + MCP calls flow over the WS.
5. On container exit, runner tars workspace (with artifact-dir excludes) and
   sends back via `workspace_download`.
6. Daemon extracts, then runs existing `commitPendingChanges`, `getDiff`,
   `pushBranch`, `mergeBranch` — no change.

Repos <500 MB → round-trip over Tailscale is bounded (~30s typical).

### Placement semantics

New `placement` field on Profile (and optional override on Session):

```ts
type Placement =
  | { kind: 'local-docker' }
  | { kind: 'aci' }
  | { kind: 'runner'; runnerId: string };
```

Legacy `executionTarget` is preserved for backwards compat; placement takes
precedence when set and is the new canonical field.

### `runner_offline` state

New session status in the state machine:
- `running → runner_offline` when daemon's WS to runner drops for an active
  session.
- `runner_offline → running` when runner reconnects and reports container
  still alive.
- `runner_offline → failed` when runner reconnects and reports container
  gone.
- `runner_offline → killing` (user-initiated kill).

### Azure deployment — small VM, not Container Apps/Files

Azure Files is incompatible with git (wildcard fetches fail; documented in
project CLAUDE.md). Container Apps + App Service rely on SMB-backed storage
for state. The right fit for a single-user budget deploy is a **Burstable VM
(Standard_B1s, ~$8/mo)** with a managed disk. systemd + the existing daemon
Docker image runs the service; Tailscale handles client/runner access.

## Alternatives Considered

- **Thick runner** (runner owns worktree + git). Correct for multi-GB repos
  or laptop-local worktree inspection. Rejected — repos are <500 MB and
  laptop-local worktrees aren't needed. Complexity isn't paid back.
- **Remote Docker socket over TLS/SSH.** Trivial to set up but worktree
  bind-mounts reference the wrong filesystem. Rebuilding worktree-shipping
  = thin-runner protocol with worse security.
- **Tag-based routing / runner pools.** Deferred — single-user doesn't need
  K8s-style scheduling. Named targets suffice.
- **Auto-spillover to ACI.** Rejected — user picks placement on purpose
  (heavy repo → laptop). Silent re-route burns money on the wrong executor.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| MCP proxy latency (container → runner → daemon) | Loopback hop for runner-side; persistent WS; target <50ms overhead; benchmark in acceptance tests |
| Workspace tar size blow-up from build artifacts | Exclude `node_modules`, `dist`, `.next`, `bin`, `obj`, `target/` on tar-back; document exclusions |
| Runner/daemon version skew | Protocol version in hello message; daemon rejects incompatible runner with clear error |
| Token-burn during partition (runner up, daemon unreachable) | Runner watchdog: WS unreachable >60s → runner stops containers + fails session locally |
| Pi SD corruption loses SQLite | Document daily backup script to Azure Blob; ship `scripts/backup-db.sh` |

## Dependency graph

```
01 protocol contracts
   ├─→ 02 daemon: runner registry + WS server
   │        ├─→ 03 daemon: RemoteContainerManager
   │        │        └─→ 04 placement + factory → 05 runner_offline state
   │        └─→ 10 desktop: runner UI
   ├─→ 06 runner: package skeleton
   │        ├─→ 07 runner: Docker adapter + workspace tar
   │        └─→ 08 runner: MCP proxy
   └─→ 09 deployment guides
```

## Scope caveats

**In v1:** protocol + runner package + daemon wiring + placement + runner_offline
state + desktop UI + Azure VM + Pi deploy docs.

**Deferred:** runner pools, runner auto-update, SQLite backup integration
beyond a script, token-burn hardening beyond the 60s watchdog, web UI.
