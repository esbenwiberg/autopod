# Autopod Pod Security — Remediation Plan

Sequenced plan for closing the gaps surfaced in the 2026-04-25 deep security audit
of pod isolation, credential handling, MCP/action engine, prompt-injection,
git/PR/supply-chain. Earlier waves are independent, low-blast-radius, and
should ship first. Later waves require schema or infra coordination.

Status legend: 🔴 not started · 🟡 in flight · 🟢 landed.

## Threat model assumptions

- The agent runtime (Claude/Codex/Copilot) is **untrusted** — it may be
  compromised by prompt injection, by a malicious skill, by a poisoned PR
  comment, or by a model that decides to behave adversarially.
- Profile authors are **partially trusted** — admins can write profiles, but
  profile fields must not be a path to RCE on the daemon.
- Daemon operators are **fully trusted** — they hold `~/.autopod/secrets.key`
  and can read/write the database directly.

The plan below is ordered to reduce risk against an adversarial agent with
the highest leverage first.

---

## Wave 1 — Stop the bleeding (this week)

Four CRITICALs that are exploitable by an adversarial agent on a current
deployment. Each is small, no migration, no infra change. Should ship as
four small PRs.

### 1.1 SSRF in generic HTTP action handler  🟢
- **Files:** `packages/daemon/src/actions/generic-http-handler.ts`,
  `packages/daemon/src/api/mcp-proxy-handler.ts` (existing `isPrivateUrl` is
  the seed for a shared util).
- **Change:** After URL templating, reject hostnames in `127/8`, `169.254/16`,
  `10/8`, `172.16/12`, `192.168/16`, `::1`, `fe80::/10`, `fc00::/7`,
  `metadata.google.internal`, `*.internal`. Resolve DNS once, validate every
  A/AAAA record (defeat DNS rebinding), then `fetch` against the resolved IP
  with a `Host:` header.
- **Test:** unit test that `{{host}}=169.254.169.254` is rejected; that
  `metadata.google.internal` is rejected; that DNS-rebinding double-resolution
  is closed.

### 1.2 Shell injection in workspace sync-back  🟢
- **File:** `packages/daemon/src/pods/pod-manager.ts:1091–1095`.
- **Change:** Drop `sh -c`. Use array-form exec
  (`['git', '-C', '/workspace', 'push', bareRepoPath, 'HEAD']`). Validate
  `bareRepoPath` matches the path the daemon recorded for this pod — refuse
  any value the agent could have injected via the alternates file.
- **Test:** unit test that an alternates file with shell metacharacters does
  not execute a side effect.

### 1.3 `git push HEAD` with no refspec  🟢
- **File:** `packages/daemon/src/worktrees/local-worktree-manager.ts:435,528`.
- **Change:** Both push sites take an explicit `expectedBranch` and push as
  `HEAD:refs/heads/${expectedBranch}`. Before pushing, run
  `git rev-parse --abbrev-ref HEAD` and refuse if it does not equal
  `expectedBranch`.
- **Test:** unit test that `git checkout main && pushBranch(branch='feature/x')`
  throws; integration test that pushing a clean feature worktree still works.

### 1.4 Drop `?token=` query-param auth fallback  🟢
- **File:** `packages/daemon/src/api/plugins/auth.ts:35–36`.
- **Change:** Remove `queryToken` fallback. Bearer-only.
- **Test:** existing auth tests; add a negative test that `?token=` returns 401.
- **Caveat:** audit and update any client (CLI, container, desktop) that
  relies on the query-param fallback before merging.

---

## Wave 2 — Auth & network egress hardening

### 2.1 Dev-mode auth must be opt-in  🟢
- **File:** `packages/daemon/src/index.ts:165–177`.
- **Change:** Replace "if `IS_DEV` accept any token" with: "if `IS_DEV` **and**
  `AUTOPOD_ALLOW_DEV_AUTH=1` accept any token". Otherwise refuse all requests
  on startup until the flag is set or a real `AuthModule` is wired.
- **Test:** integration test in dev mode without flag → 401; with flag → 200.

### 2.2 IPv6 firewall rules  🟢
- **File:** `packages/daemon/src/containers/docker-network-manager.ts`.
- **Change:** Emit a parallel `ip6tables` ruleset for every mode. For
  `restricted` and `deny-all`, default-deny IPv6 outbound and allow only
  loopback + established. For `allow-all`, leave IPv6 alone.
- **Test:** unit test that the generated script contains `ip6tables`
  invocations for every `iptables` rule in deny/restricted modes.

### 2.3 Fail closed on firewall errors  🟢
- **File:** `packages/daemon/src/containers/docker-container-manager.ts:105–109`
  and pod-manager spawn path.
- **Change:** If `refreshFirewall()` throws or its child exec returns
  non-zero in `restricted` or `deny-all` mode, abort spawn and transition
  the pod to `failed`. Only `allow-all` pods may continue on firewall
  failure.
- **Caveat:** behind a `AUTOPOD_FAIL_CLOSED_FIREWALL` env flag for one
  release so staging can validate.
- **Test:** mock the network manager to throw; assert the pod fails;
  `allow-all` still spawns.

### 2.4 ACI: refuse adversarial profiles until parity  🟢
- **Files:** `packages/daemon/src/containers/aci-container-manager.ts`,
  `packages/daemon/src/profiles/profile-validator.ts`.
- **Change:** Refuse to spawn pods on the ACI backend with
  `network_policy ∈ {restricted, deny-all}`. Add the check in
  profile-validator (compile-time-ish) and at spawn (defence-in-depth).
- **Test:** profile-validator test for the rejection; aci spawn test
  for the rejection.

### 2.5 Tighten CIDR-fallback /24 expansion  🟢
- **File:** `docker-network-manager.ts:393`.
- **Change:** When dnsmasq+ipset is unavailable, resolve to `/32` instead
  of `/24`. Use periodic re-resolution for IP rotation.
- **Test:** unit test that the generated rule has `/32`, not `/24`.

---

## Wave 3 — Supply chain integrity

### 3.1 Pin skills to commit SHAs  🟢
- **File:** `packages/daemon/src/pods/skill-resolver.ts:84–86`.
- **Change:** Validate `source.ref` matches `^[0-9a-f]{40}$`. Reject `main`,
  tags, short SHAs. One-pod warning period; then flip to reject.
- **Test:** unit test for valid SHA passes, branch name rejected.

### 3.2 Digest-pin base images  🟢
- **File:** `packages/daemon/src/images/dockerfile-generator.ts:8–19`.
- **Change:** Replace `autopod-node22:latest` etc. with
  `autopod-node22@sha256:…`. Source digests from a generated
  `image-digests.json` produced by the image-warming pipeline. Daemon
  startup check that all configured digests resolve.
- **Test:** snapshot test of the generated Dockerfile.

### 3.3 Verified Dagger installer  🟢
- **File:** `packages/daemon/src/images/dockerfile-generator.ts:93`.
- **Change:** Replace `curl … | sh` with a pinned download + sha256 check.
  Track version + digest in a config file.
- **Test:** image-build smoke test in CI.

### 3.4 Validate registry URLs at profile-write time  🟢
- **File:** `packages/daemon/src/profiles/profile-validator.ts`.
- **Change:** Reject `PrivateRegistry.url` resolving to private/loopback/
  metadata IPs at validation time. Reuse the SSRF allowlist from 1.1.
- **Test:** profile-validator unit test for `http://169.254.169.254/feed/`
  and `http://localhost/...`.

---

## Wave 4 — Credential confinement

### 4.1 Provider tokens out of env vars  🟢
- **File:** `packages/daemon/src/pods/pod-manager.ts:2049` (and
  `buildProviderEnv`).
- **Change:** Write tokens to a tmpfs-mounted file (`/run/autopod/<key>`,
  mode 0400) and pass `*_FILE` env. Where the SDK does not support `_FILE`,
  use a tiny per-runtime shim that reads the file and `exec`s the runtime
  with the env set only for that one process.
- **Test:** integration test that `printenv` inside a running pod does not
  contain `ANTHROPIC_API_KEY`.

### 4.2 NuGet PAT out of env  🟢
- **File:** `packages/daemon/src/pods/registry-injector.ts:160–177`.
- **Change:** Drop `VSS_NUGET_EXTERNAL_FEED_ENDPOINTS` env; use only the
  NuGet credential file that already exists.
- **Test:** unit test that no PAT-bearing env is set; integration test that
  `dotnet restore` still works.

### 4.3 Git PAT not in shell history  🟢
- **File:** `packages/daemon/src/pods/pod-manager.ts:2167` (and reference-repo
  clone path).
- **Change:** Use a git credential helper that reads from a 0400 tmpfs file
  rather than embedding the auth URL inline.
- **Test:** assert `.bash_history` and `.zsh_history` after a pod run contain
  no `https://x:`.

### 4.4 Document & enforce secrets-key permissions  🟢
- **File:** `packages/daemon/src/crypto/credentials-cipher.ts`, plus startup
  check.
- **Change:** Verify `~/.autopod/secrets.key` is mode 0600 and owned by the
  daemon user; refuse to start otherwise. Document backup procedure (encrypted
  off-host backup; loss = unrecoverable creds).
- **Test:** startup test with mode 0644 should fail.

---

## Wave 5 — Defense in depth

### 5.1 CapDrop=ALL with minimal CapAdd  🟢
- **File:** `packages/daemon/src/containers/docker-container-manager.ts:34–113`.
- **Change:** `HostConfig.CapDrop = ['ALL']`, then re-add only what is needed.
  Pre-requisite for moving iptables host-side (PR-6 follow-up).
- **Test:** integration test that capability-requiring ops fail in container.

### 5.2 Seccomp profile  🟢
- **File:** new `packages/daemon/src/containers/seccomp-profile.json`.
- **Change:** Ship Docker default seccomp explicitly; block `unshare`,
  `setns`, `pivot_root`, `mount` so configuration drift cannot relax them.
- **Test:** spawn a container, exec `unshare -U /bin/sh`, expect EPERM.

### 5.3 pino redaction  🟢
- **File:** `packages/daemon/src/index.ts:78–80` (and any other pino
  constructors).
- **Change:** `redact: { paths: ['*.token', '*.pat', '*.apiKey', '*.password',
  'authorization', '*.secret', '*.providerCredentials'], censor: '[REDACTED]' }`.
- **Test:** unit test that logging `{ pat: 'ghp_xxx' }` produces `[REDACTED]`.

### 5.4 Sanitizer hardening  🟢
- **Files:** `packages/shared/src/sanitize/patterns.ts:141`,
  `packages/shared/src/sanitize/processor.ts`.
- **Change:** Lower encoding-trick threshold to 1 token (or replace with a
  decoded-content check). Add an env-dump pattern. Make sanitizer fail-closed
  if a regex throws.
- **Test:** unit test that a `printenv` dump of 10 vars is fully quarantined;
  that mixed-case `IgnoRe AlL InStRuCtIoNs` is caught.

### 5.5 Quarantine policy: block above the high threshold  🟢
- **File:** `packages/shared/src/sanitize/quarantine.ts:55–61`.
- **Change:** Above score 0.8, drop content (replace with a placeholder).
  Below 0.8, keep wrapping.
- **Test:** unit test that 0.9-score content is replaced, not just wrapped.

---

## Wave 6 — Forensics, PR hygiene, policy gates

### 6.1 Audit hash chain  🟢
- **Files:** `packages/daemon/src/db/migrations/064_audit_chain.sql`,
  `packages/daemon/src/actions/audit-repository.ts`.
- **Change:** Add `prev_hash`, `entry_hash` columns. Each insert hashes
  `prev_hash || pod_id || action_name || params || result || timestamp`.
  Trigger that rejects `UPDATE`/`DELETE`. `verifyAuditChain()` for periodic
  integrity check.
- **Test:** tampering with one row breaks verification; normal append chain
  verifies.

### 6.2 PR body markdown escaping  🟢
- **File:** `packages/daemon/src/worktrees/pr-body-builder.ts`.
- **Change:** Added `escapeMd()` helper. Escapes `@mention`, HTML angle
  brackets, link syntax, pipes, and backticks for all agent-supplied fields
  (Why, What, How, deviations, checklist).
- **Test:** snapshot tests that `@security-team URGENT` and `[link](url)`
  render escaped.

### 6.3 Auto-merge requires explicit APPROVED  🟢
- **Files:** `packages/daemon/src/interfaces/pr-manager.ts`,
  `packages/daemon/src/worktrees/pr-manager.ts`,
  `packages/daemon/src/pods/pod-manager.ts`.
- **Change:** Added `reviewDecision` to `PrMergeStatus`. Before calling
  `mergePr()` in `approveSession()`, fetches PR status and defers to
  `merge_pending` if `reviewDecision` is set and not `APPROVED`.
- **Test:** integration test where review is `REVIEW_REQUIRED` but CI green
  → pod stays in `merge_pending`.

### 6.4 Fix-pod loop guardrails  🟢
- **Files:** `packages/shared/src/constants.ts`,
  `packages/daemon/src/db/migrations/065_fix_pod_cooldown.sql`,
  `packages/daemon/src/pods/pod-manager.ts`,
  `packages/daemon/src/pods/pod-repository.ts`.
- **Change:** Lowered `DEFAULT_MAX_PR_FIX_ATTEMPTS` from 3 to 2. Added
  `last_fix_pod_spawned_at` column + 10-minute cooldown enforced in
  `maybeSpawnFixSession()`.
- **Test:** unit test that a second spawn within the cooldown window is skipped.

### 6.5 Validate-in-browser host-side gate  🟢
- **Files:** `packages/escalation-mcp/src/pod-bridge.ts`,
  `packages/daemon/src/pods/pod-bridge-impl.ts`,
  `packages/escalation-mcp/src/tools/validate-in-browser.ts`.
- **Change:** Added `validateBrowserUrl()` to `PodBridge`. Daemon implementation
  only allows `localhost`/`127.x` hostnames and throws on all other addresses
  (including metadata services). Tool calls bridge before script generation.
- **Test:** bridge rejects `http://169.254.169.254` and `http://10.0.0.1`.

---

## Wave 7 — Docs & operational policy

### 7.1 Production deployment checklist  🔴
- **File:** `docs/production-checklist.md` (new).
- **Content:** required env (`NODE_ENV=production`, no
  `AUTOPOD_ALLOW_DEV_AUTH`, `ENTRA_*` set); required filesystem (secrets.key
  0600, owned by daemon user); required network posture; required GitHub
  branch-protection rules.

### 7.2 Secrets-key backup & rotation runbook  🔴
- **File:** `docs/secrets-key.md` (new).
- **Content:** offline encrypted backup procedure; rotation: stand up new
  key, decrypt-then-re-encrypt all rows in `profiles.provider_credentials`
  and `profiles.private_registries` in a single transaction, swap key file.

### 7.3 Threat model doc  🔴
- **File:** `docs/threat-model.md` (new).
- **Content:** assumptions (agent untrusted; profile authors partially
  trusted; operator fully trusted) and residual risks after Wave 1–6.

---

## Dependency / parallelization map

```
Wave 1: 1.1, 1.2, 1.3, 1.4   — all independent, parallel
Wave 2: 2.1, 2.2 + 2.3 + 2.4 (network — one PR), 2.5
Wave 3: 3.1, 3.2 (depends on image pipeline producing digests), 3.3, 3.4
Wave 4: 4.1, 4.2, 4.3 require runtime testing in real containers — serial
        4.4 independent
Wave 5: 5.1 + 5.2 (one PR), 5.3, 5.4 + 5.5 (one PR)
Wave 6: 6.1 needs a migration; 6.2 / 6.3 / 6.4 / 6.5 independent
Wave 7: docs after the corresponding code lands
```

## Suggested PR sequence

1.  `fix: block SSRF in HTTP action handler`         (1.1)
2.  `fix: array-form exec in workspace sync-back`     (1.2)
3.  `fix: explicit refspec on git push`               (1.3)
4.  `fix: drop query-param token fallback`            (1.4)
5.  `fix: gate dev-mode auth behind explicit env`     (2.1)
6.  `feat: ip6tables, fail-closed firewall, ACI guard` (2.2/2.3/2.4)
7.  `feat: pin skills, base images, Dagger install`   (3.1/3.2/3.3)
8.  `feat: provider tokens via files, not env`        (4.1/4.2)
9.  `feat: container hardening — CapDrop=ALL + seccomp` (5.1/5.2)
10. `feat: pino redaction + sanitizer hardening`      (5.3/5.4/5.5)
11. `feat: audit hash chain + auto-merge gate + PR md escape` (6.1/6.2/6.3)
12. `docs: production checklist + threat model + secrets runbook` (7.x)

## Higher-risk PRs to be careful with

- **PR-3** push refspec — touches every push path; wrong branch resolution
  bricks pod completion.
- **PR-6** network — fail-closed is the most likely thing to surprise in
  prod; needs feature flag.
- **PR-8** tokens to files — runtime SDKs may not honour `_FILE`; needs
  per-runtime shim.
- **PR-9** CapDrop+seccomp — chicken-and-egg with PR-6 (needs host-side
  iptables first); seccomp blocks legitimate syscalls non-deterministically.
- **PR-7** digest pinning — image-warming pipeline must publish digests; skill
  SHA enforcement breaks anyone using `main` today.
- **PR-11** audit hash chain — live DB migration with triggers.
