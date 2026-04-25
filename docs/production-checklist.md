# Autopod Production Deployment Checklist

Verify every item before going live. Items marked **REQUIRED** will prevent the daemon from starting or leave a critical security gap. Items marked **RECOMMENDED** close important attack surface but have workarounds.

---

## 1. Environment Variables

### Required

| Variable | Required value / constraint | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables auth enforcement. Without this, all API requests are accepted without a valid Entra token. |
| `ENTRA_CLIENT_ID` | Real Azure AD app client ID (UUID) | Must match the registered app in your tenant. |
| `ENTRA_TENANT_ID` | Real Azure AD tenant ID (UUID) | Daemon validates JWTs against this tenant's OIDC endpoint. |
| `DB_PATH` | Absolute path on a durable volume (e.g. `/data/autopod.db`) | Defaults to `./autopod.db` which is lost on container restart. |

### Must NOT be set in production

| Variable | Why |
|---|---|
| `AUTOPOD_ALLOW_DEV_AUTH` | Setting this to `1` in production bypasses Entra JWT validation entirely — any bearer token is accepted. |

### Recommended

| Variable | Recommended value | Notes |
|---|---|---|
| `AUTOPOD_FAIL_CLOSED_FIREWALL` | `1` | Without this, a firewall setup failure leaves the pod's network open. With it, the pod is marked `failed` instead of running unprotected. Enable once staging has validated the iptables rules. |
| `LOG_LEVEL` | `warn` or `info` | `debug` logs raw request bodies — avoid in production. |
| `MAX_CONCURRENCY` | ≤ number of CPU cores | Prevents resource exhaustion. Default is 3. |
| `TEAMS_WEBHOOK_URL` | Your Teams channel webhook | Enables pod failure notifications. |
| `PORT` | `3100` (or a firewall-restricted port) | Default is fine; ensure it is not directly internet-exposed. |
| `HOST` | `127.0.0.1` (if reverse-proxied) | Use `0.0.0.0` only when the daemon terminates TLS directly. |

### ACI-specific (if using Azure Container Instances)

| Variable | Required for ACI |
|---|---|
| `AZURE_SUBSCRIPTION_ID` | yes |
| `AZURE_RESOURCE_GROUP` | yes |
| `AZURE_LOCATION` | yes |
| `ACR_REGISTRY_URL` | yes |
| `ACR_USERNAME` | yes |
| `ACR_PASSWORD` | yes |

---

## 2. Filesystem & File Permissions

### Secrets key

```
~/.autopod/secrets.key   (or $AUTOPOD_SECRETS_KEY_PATH)
```

- [ ] File exists and is exactly 32 bytes (256-bit AES key).
- [ ] Permissions are `0600` (`-rw-------`). The daemon refuses to start if they are wider.
- [ ] Owned by the daemon process user (e.g. `autopod:autopod`, UID 1000 in the production Docker image).
- [ ] An offline encrypted backup exists — see [`docs/secrets-key.md`](secrets-key.md). **Loss of this file means all stored credentials are permanently unrecoverable.**

Check:
```bash
stat -c '%a %U' ~/.autopod/secrets.key
# Expected: 600 autopod
```

### Database volume

- [ ] `DB_PATH` directory is writable by the daemon user.
- [ ] The volume is on durable storage (not ephemeral container filesystem).
- [ ] WAL files (`*.db-shm`, `*.db-wal`) are on the same filesystem as the `.db` file — don't split them across mounts.

### Docker socket

- [ ] `/var/run/docker.sock` is accessible to the daemon process.
- [ ] The daemon user is in the `docker` group **or** the socket is bind-mounted with appropriate group permissions.
- [ ] The socket is not world-readable on the host — Docker socket access is equivalent to root.

---

## 3. Network Posture

### Host-level

- [ ] The daemon's HTTP port is **not** directly internet-exposed. Terminate TLS at a reverse proxy (nginx, Caddy, Azure Application Gateway).
- [ ] `ip6tables` is available on the Docker host — required for IPv6 network isolation in `deny-all` and `restricted` network policies.
- [ ] `ipset` and `dnsmasq` are installed on the Docker host — required for domain-based allowlists in `restricted` mode. Without them, the daemon falls back to CIDR-only rules (`/32` per resolved IP).

Check:
```bash
which ip6tables ipset dnsmasq
```

### Pod egress (per profile)

- [ ] All profiles that handle sensitive data use `network_policy: deny-all` or `network_policy: restricted`, not `allow-all`.
- [ ] ACI profiles do **not** use `deny-all` or `restricted` network policies (iptables parity not yet implemented for ACI — the daemon will reject such profiles at write time).
- [ ] `AUTOPOD_FAIL_CLOSED_FIREWALL=1` is set so that firewall failures abort the pod rather than leaving it exposed.

### Outbound from daemon

- [ ] If a corporate proxy is required, set `HTTP_PROXY` / `HTTPS_PROXY` and ensure Docker containers inherit or have equivalent proxy config.
- [ ] The daemon must reach:
  - Azure AD OIDC endpoint (`login.microsoftonline.com`) for token validation
  - GitHub API (`api.github.com`) for PR management and skill resolution
  - Docker Hub or your ACR for image pulls
  - Any `restricted`-policy allowlisted hosts

---

## 4. GitHub Branch Protection

Configure these rules on the target repositories that Autopod will open PRs against:

- [ ] **Require a pull request before merging** — prevents the auto-merge path from merging without review.
- [ ] **Require approvals** — at minimum 1 required reviewer. Autopod's `approveSession()` respects `reviewDecision` and will not merge until the PR is `APPROVED`.
- [ ] **Require status checks to pass before merging** — your CI must be listed as a required check.
- [ ] **Require branches to be up to date before merging** — prevents stale-base merges.
- [ ] **Do not allow bypassing the above settings** — prevents administrators from skipping checks.
- [ ] **Restrict who can push to matching branches** — only the Autopod service account (or approved humans) should be able to push to `main`/`master`.
- [ ] **Do not allow force pushes** — the `local-worktree-manager` uses explicit refspecs; force-push should never be required.
- [ ] **Do not allow deletions** — prevents accidental branch removal.

---

## 5. Runtime Security

- [ ] Container images are built from the production Dockerfile (multi-stage, Alpine base, non-root `autopod:1000` user).
- [ ] Image digests are pinned in `image-digests.json` — the daemon verifies these at startup. Floating tags (`latest`, branch names) are rejected.
- [ ] Skill `source.ref` fields use full 40-character SHA1 commit hashes — branch names and short SHAs are rejected.
- [ ] The Dagger installer in the Dockerfile uses a pinned version + sha256 checksum (no `curl | sh`).
- [ ] Containers run with `CapDrop=ALL` and only the minimal capability set re-added (defined in `docker-container-manager.ts`).
- [ ] The seccomp profile (`seccomp-profile.json`) is applied — this blocks `unshare`, `setns`, `pivot_root`, and `mount`.

---

## 6. Auth & API Security

- [ ] Confirm the deployed binary has `NODE_ENV=production`. A quick check:
  ```bash
  curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/health
  # Should return 200 (health is unauthenticated)
  curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/api/pods
  # Should return 401 (no valid Entra token)
  ```
- [ ] Query-string token auth (`?token=`) is disabled — Bearer header only.
- [ ] Rate limiting is active (default Fastify rate-limit plugin — 100 req/min per IP).
- [ ] CORS is configured with an explicit `origin` allowlist, not `*`.

---

## 7. Observability

- [ ] `pino` log redaction is active — verify that `*.token`, `*.pat`, `*.apiKey`, `*.password`, `*.secret`, `authorization`, and `*.providerCredentials` fields are replaced with `[REDACTED]` in log output.
- [ ] Logs are shipped to a durable store (not just container stdout).
- [ ] `GET /health` returns 200 — integrate this into your load balancer health check.
- [ ] Alert on pod `failed` transitions — the event bus emits these as `SystemEvent` WebSocket messages; your monitoring adapter should subscribe.
- [ ] Audit chain integrity is verified periodically — `verifyAuditChain()` in `action-audit-repository.ts`. Wire this to a cron or startup check.

---

## 8. Pre-Launch Smoke Test

```bash
# 1. Health
curl http://localhost:3100/health

# 2. Version
curl http://localhost:3100/version

# 3. Unauthenticated pod list → must 401
curl http://localhost:3100/api/pods

# 4. Authenticated pod list → must 200
TOKEN=$(cat ~/.autopod/dev-token)   # dev only
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/pods

# 5. Create a minimal pod with deny-all network and verify it reaches failed
#    (no task to run; confirms state machine and firewall path)
```
