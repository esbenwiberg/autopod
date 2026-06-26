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
scripts/deploy-hosted-daemon.sh --rollback <sha># repoint + restart, nothing else
```

It runs the full dance: preflight → build new release on the VM → verify the
built bundle → atomic symlink swap → restart → post-verify (local + external
health) → print rollback → prune old releases. It refuses to swap unless the
build completed and health is green, so a failed run leaves `current` untouched.

## Judgment the script can't make for you

- **Restart only at 0 active pods.** The script aborts if non-terminal pods
  exist. Do **not** reach for `--force` just to push through — you'd kill a live
  pod's daemon mid-run. Wait, or confirm with the user that the running pods are
  expendable.
- **Deps changed = different deploy.** If `package.json`/`pnpm-lock.yaml` moved
  between live and target, the node_modules-reuse shortcut is invalid. The script
  auto-detects this and switches to `--full` (clean clone + `pnpm install`). Trust
  that; don't override it back to overlay.
- **Drifted box = full build.** If the live release sha isn't in your local git
  (box drifted far from main, or built off a branch), overlay can't compute a safe
  file set — the script forces `--full`. Good. Let it.
- **Verify the right thing.** When you're deploying a *specific* fix, pass
  `--verify-string '<a code string from the change>'`. It greps the **built
  bundle** (newlines flattened), never source, never a comment — comments are
  stripped by the bundler, so a naive source grep lies. Pick a string that only
  exists after the change.

## Rollback discipline

Every successful run prints the exact rollback command (`--rollback <prev-sha>`).
If anything looks off after deploy — external health not 200, journal errors,
behavior regressed — roll back first, diagnose second. The old release is still
on the box (pruning protects both current and previous-live).

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
- If sandbox MCP behavior was part of the change, smoke a pod
  (`ap pod create --profile <sandbox> --task "..."`) to confirm end-to-end.
- Related runbook for TLS/Caddy/Entra (not code deploy): `docs/hosted-daemon-tls-entra.md`.
