# ADR 004: Azure daemon hosted on a small Burstable VM

## Context

The daemon must be optionally hostable in Azure, cheaply, for a single user.
Candidates:

| Option | Monthly cost | Storage for git+SQLite | Docker access |
|--------|--------------|------------------------|---------------|
| Container Apps | $0–30 (scale-to-zero) | Azure Files (SMB) | No Docker-in-container |
| App Service | $13+ | Custom FS (SMB) | No socket access |
| Azure VM Standard_B1s | $8–15 | Managed disk (local SSD) | Native |
| ACI | $30+ (continuously running) | Azure Files | No socket |

Project CLAUDE.md explicitly warns: "Azure File Share — use explicit fetch
refspec: `git fetch origin +refs/heads/main:refs/remotes/origin/main`.
Wildcard fetches fail on Azure SMB mounts." Bare repo caches need many git
operations; relying on SMB is asking for pain.

## Decision

**Azure Burstable VM (Standard_B1s, ~$8/mo) with a managed disk** is the
documented Azure deployment. systemd + the existing daemon Docker image
runs the service. Tailscale handles client/runner access.

## Consequences

**Good**
- Git operations run on local SSD. No SMB weirdness.
- SQLite WAL mode works without contention issues.
- Azure Backup on the managed disk provides daily snapshots out of the box.
- Lowest monthly cost among viable options.
- Same Docker image as Pi — deployments are symmetric.

**Bad**
- Not fully managed. User has to apply OS patches, manage TLS certs,
  rotate the Tailscale credential. Not a problem for the "technical user
  with a Pi and Tailscale already set up" persona.
- B1s has credits-based CPU — sustained load throttles. Daemon is mostly
  I/O-bound, so unlikely to matter.
- No scale-to-zero; always billed. Still cheaper than Container Apps at
  steady state for a single user.

## Alternatives

- **Container Apps.** Azure Files for state = git-hostile. Rejected.
- **App Service Linux.** Same SMB storage problem. No Docker socket for
  local-docker executor target (not a real loss since users running
  daemon in Azure won't use local-docker; ACI / runner targets cover it).
- **Azure ACI for the daemon itself.** Expensive for 24/7 and still needs
  Azure Files for state.
- **Managed VM with disk.** What we're picking.
