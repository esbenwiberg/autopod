---
name: deploy-hosted-daemon
description: Deploy a commit to the hosted Autopod daemon VM (Azure, no SSH). Use when asked to deploy/ship/update/redeploy the hosted daemon, roll out a daemon fix to the cloud box, or roll back the hosted daemon. Wraps scripts/deploy-hosted-daemon.sh with the runbook judgment the bare script can't encode.
---

# /deploy-hosted-daemon

Ship a commit to the hosted Autopod daemon and verify it's actually live. The
muscle is `scripts/deploy-hosted-daemon.sh`; this skill is the runbook — when to
run it, which mode, and how to bail safely.

## What you're deploying to

- Azure VM `autopod-daemon` in resource group `ewi-sandboxes`. **No SSH** — all
  remote work goes through `az vm run-command invoke` (you must be `az login`'d).
- Caddy terminates HTTPS at
  `https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com` → `127.0.0.1:3100`.
- Releases live at `/opt/autopod/releases/<sha>`; `/opt/autopod/current` is a
  symlink; systemd unit `autopod-daemon` runs the node process from it as `ewi`.

## The one command

```bash
scripts/deploy-hosted-daemon.sh                 # deploy origin/main HEAD
scripts/deploy-hosted-daemon.sh --target <sha>  # deploy a specific commit
scripts/deploy-hosted-daemon.sh --rollback <sha>  # repoint, restart, check health
```

A normal deploy builds the release, prewarms and launch-checks Chromium, and
checks any requested verification string **before** switching `current`. Failure
at those steps leaves the live release untouched.

The script then switches `current`, restarts the daemon, and checks local and
external health. If a post-swap health check fails, **the new release stays
selected**. There is no automatic rollback: use `--rollback <previous-sha>`
to switch back. On success, the script prunes old releases (keeping current,
previous-live and the `--keep N` newest others; default 2), then prints the
rollback command.

Local post-restart health is retried for up to roughly one minute. A busy host
can take longer than a fixed sleep to bind port 3100; only exhaustion of the
bounded retry window is a deployment failure.

## Judgment the script can't make for you

- **Queued pods do not block restarts.** They own no running workload and remain
  queued across a daemon restart. Provisioning, running, validating, paused, and
  other mid-lifecycle states do block ordinary deploys.
- **`--force` means explicit interruption authority.** Use it only after the
  user explicitly approves restarting despite the exact restart-blocking pods.
  It bypasses the pod-count gates with loud warnings; build, reviewer/browser
  prewarm, bundle verification, service health, and rollback gates still apply.
- **Deps changed = different deploy.** If `package.json`/`pnpm-lock.yaml` moved
  between live and target, the node_modules-reuse shortcut is invalid. The script
  auto-detects this and switches to `--full` (clean clone + `pnpm install`). Trust
  that; don't override it back to overlay.
- **Drifted box = full build.** If the live release sha isn't in your local git
  (box drifted far from main, or built off a branch), overlay can't compute a safe
  file set — the script forces `--full`. Good. Let it.
- **Verify the right thing.** When you're deploying a *specific* fix, pass
  `--verify-string '<a code string from the change>'`. Use a literal that appears on **one line** in a
  generated `.js` or `.py` file under `packages/daemon/dist` and is unique to
  the change. The script searches built files line by line; it does not flatten
  newlines or search source maps.
- **Browser readiness is part of deploy.** Provision Playwright Linux
  dependencies **only as a separate host provisioning operation**, not from a
  release during deploy. The deploy installs daemon Chromium into the `ewi`
  service user's cache and launch-checks it as that user before swapping. Do not use `--skip-playwright-prewarm`
  unless this is an emergency deploy where browser validation is explicitly
  allowed to be degraded.
- **Daemon browser prewarm is paired with app-local prewarm.** Required facts of
  kind `browser-test` run app worktree commands such as `npm run smoke`; those
  commands may use a newer app-local Playwright than the daemon package.
  Validation now prewarms `node_modules/.bin/playwright install chromium` in the
  affected worktree before running the fact. If that still reports "Playwright
  browser executable is missing or mismatched", inspect the affected worktree as
  `ewi` and prewarm that version there, for example:
  `sudo -u ewi -H bash -lc 'cd /home/ewi/.autopod/worktrees/<pod> && npx playwright install chromium'`.
  Treat a waiver as a temporary operator decision, not durable browser coverage.

- **Docker network capacity is a host condition, not a deploy step.** The
  preflight prints `Docker network capacity: ...` from `/health?detail=full`
  and warns on `warning` or `critical`. It never blocks. A deploy neither frees
  nor consumes subnets. If it is critical, tell the user that new local pods
  fail with `HOST_NETWORK_CAPACITY` until capacity is freed. Do not "fix" it
  during a deploy:
  - Never `docker network rm` retained-checkpoint bridges.
  - Never edit `/etc/docker/daemon.json` or restart dockerd as part of a
    deploy. Without `live-restore`, a dockerd restart stops every running pod
    container.
  - Enlarging `default-address-pools` is a separate operator procedure with
    its own approval and maintenance window. See
    `docs/hosted-daemon-docker-networks.md`.

## Rollback discipline

Every successful full or overlay deployment prints the exact rollback command (`--rollback <prev-sha>`).
If anything looks off after deploy — external health not 200, journal errors,
behavior regressed — roll back first, diagnose second. The old release is still
on the box (pruning always protects both current and previous-live, on top of the
`--keep N` newest other releases, default 2 — so at most N+2 releases remain).

## Before you run

- `az login` done, on the right subscription.
- You can mint a daemon token (`ap token`) — needed for the active-pods preflight.
  Without it the script warns and skips that gate; then **you** must confirm no
  pods are running before proceeding.
- You're deploying a commit that's actually pushed to `origin` — the VM clones
  from GitHub, not from your laptop's working tree. Uncommitted local changes
  will NOT ship.

## After you run

- Confirm the final line shows `DEPLOYED <old> -> <new>` and external health was
  200.
- Confirm the output included `PLAYWRIGHT_PREWARM_OK`; otherwise the deploy
  should have stopped before swapping.
- If sandbox MCP behavior was part of the change, smoke a pod
  (`ap pod create --profile <sandbox> --task "..."`) to confirm end-to-end.
- Related runbook for TLS/Caddy/Entra (not code deploy): `docs/hosted-daemon-tls-entra.md`.
