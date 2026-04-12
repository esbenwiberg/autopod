# Brief 09: Deployment — daemon (Azure VM + Pi) + runner install

## Objective

Produce the deployment artifacts and documentation for running the daemon
on an Azure Standard_B1s VM or a Raspberry Pi, and for installing the
runner on macOS + Linux.

## Dependencies

Briefs 02, 03 — daemon-side runner support must exist for the deployment
guide to be verifiable.

## Blocked By

Briefs 02, 03, 06, 07, 08.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `Dockerfile` | modify | Ensure multi-arch build (amd64 + arm64) — likely already works; add `--platform` arg if missing |
| `docker-compose.yml` | modify | Add optional `TAILSCALE_AUTHKEY` env + expose runners WS endpoint |
| `deploy/azure-vm/README.md` | create | Step-by-step: create VM, attach disk, install Docker + Tailscale, pull image, systemd unit |
| `deploy/azure-vm/autopod-daemon.service` | create | systemd unit for the daemon container |
| `deploy/azure-vm/setup.sh` | create | Idempotent setup script matching the README |
| `deploy/pi/README.md` | create | Pi 4/5 install: Docker, Tailscale, systemd, SD backup script |
| `deploy/pi/autopod-daemon.service` | create | systemd unit (arm64) |
| `deploy/pi/setup.sh` | create | Install script |
| `deploy/runner/macos/README.md` | create | Install runner, register, launchd plist |
| `deploy/runner/macos/com.autopod.runner.plist` | create | launchd plist |
| `deploy/runner/linux/README.md` | create | Install runner, register, systemd unit |
| `deploy/runner/linux/autopod-runner.service` | create | systemd unit |
| `scripts/backup-db.sh` | create | Rsync / az blob upload of SQLite db with WAL flush |

## Interface Contracts

None — documentation + deploy artifacts only.

## Implementation Notes

- Azure VM flow: `az vm create` (Standard_B1s, Ubuntu 22.04), attach a
  Premium SSD data disk (~32 GB), Tailscale authkey, Docker via convenience
  script, systemd unit runs `docker compose up`. Daemon data disk mount at
  `/mnt/autopod-data`. Env file at `/etc/autopod/daemon.env`.
- Pi flow: parallel. Assumes Raspberry Pi OS 64-bit. Point out the SD
  corruption risk and the backup script.
- Both scripts should be idempotent (re-run safe).
- Runner install: two platforms, two service managers. Keep configs
  minimal — enough for a single-user setup. Document token rotation +
  credential file location (`~/.autopod/runner/credential`).
- Backup script uses `sqlite3 .backup` over a tempfile + `az storage blob
  upload` (requires user to set `AUTOPOD_BACKUP_CONTAINER` + auth).
  Document setup in Azure VM + Pi READMEs.
- Tailscale: document the auth key generation step (Tailscale Admin UI)
  but don't automate — the user manages their tailnet.
- Docker image publishing: reuse existing CI push flow if present; if not,
  call out manual `docker buildx build --platform linux/amd64,linux/arm64 --push`
  steps. (Investigate current CI first.)

## Acceptance Criteria

- [ ] `Dockerfile` builds for both amd64 and arm64 via `docker buildx`.
- [ ] Azure VM README walks through from zero to a running daemon
  reachable over Tailscale.
- [ ] `setup.sh` on a fresh Ubuntu 22.04 VM completes without manual steps
  (except Tailscale auth).
- [ ] Pi README covers equivalent setup and ends with a reachable daemon.
- [ ] Runner macOS README ends with a registered + running runner that
  appears online in the desktop app.
- [ ] Runner Linux README ends equivalently.
- [ ] `scripts/backup-db.sh` produces a restorable SQLite backup; restore
  procedure documented.
- [ ] Manual smoke: run validation scenario 7 (Azure VM daemon + laptop
  runner) end to end.

## Estimated Scope

Files: 13 created + 2 modified | Complexity: medium
