# Autopod Threat Model

**Date:** 2026-04-25  
**Scope:** autopod daemon + agent container runtime, post Wave 1–6 remediations.

---

## 1. System Overview

Autopod is an AI pod orchestration daemon. It:

1. Accepts pod creation requests from authenticated CLI/desktop clients.
2. Spawns Docker (or ACI) containers running AI coding agents (Claude, Codex, Copilot).
3. Injects task context, credentials, and MCP tools into containers.
4. Manages the pod lifecycle: provisioning → running → validation → merge.
5. Exposes an MCP server that containers call back into via HTTP for escalations and actions.

The critical security property is **containment**: an agent that has been compromised by prompt injection, a malicious skill, or an adversarial model must not be able to exfiltrate credentials, compromise the host, modify infrastructure outside the allowed action set, or escalate to other pods.

---

## 2. Trust Levels

| Principal | Trust level | Rationale |
|---|---|---|
| **Daemon operators** | Fully trusted | Hold `~/.autopod/secrets.key`, have DB access, configure the daemon. Assumed to be internal admins. |
| **Profile authors** | Partially trusted | Can configure profiles (network policy, actions, skills, commands), but profile fields are validated and must not be a path to RCE on the daemon host. |
| **CLI / desktop users** | Authenticated | Must present a valid Entra JWT. Authorisation is coarse-grained (no per-pod ACLs today — see residual risks). |
| **Agent runtime** | **Untrusted** | The model, skills, and any tool-call parameters it generates are treated as adversarial. Every agent-supplied value is validated before use. |
| **GitHub / ADO** | Partially trusted | PR content, review comments, and CI results could be attacker-controlled. PR body fields are Markdown-escaped before use. |

---

## 3. Assets

| Asset | Location | Protection |
|---|---|---|
| Provider API keys (Anthropic, MAX, Foundry) | `profiles.provider_credentials` (DB) | AES-256-GCM encrypted; key at `~/.autopod/secrets.key` (0600) |
| ADO / GitHub PATs | `profiles.ado_pat`, `profiles.github_pat` | AES-256-GCM encrypted |
| Registry PATs | `profiles.registry_pat` | AES-256-GCM encrypted |
| Secrets key | `~/.autopod/secrets.key` | Filesystem 0600; must be backed up offline |
| Pod HMAC tokens | Issued per-pod | Short-lived, HMAC-SHA256; Bearer-only (no query-string) |
| Audit log | `action_audit` table | Append-only hash chain; UPDATE/DELETE blocked by DB trigger |
| Container workdir / worktrees | Git bare repos on daemon host | Scoped to the pod; cleaned up on completion |

---

## 4. Threat Actors & Scenarios

### T1 — Prompt-injected agent

**Source:** Malicious content in a repository file, PR comment, code review, or skill that hijacks the model's behaviour.

**Goal:** Exfiltrate credentials, push malicious code, call unintended actions, or pivot to the host.

**Controls in place (post Wave 1–6):**

- *Credential isolation* — provider tokens are written to tmpfs files (`/run/autopod/<key>`, mode 0400) and passed via `*_FILE` env vars rather than as environment variables that `printenv` can dump. Git PATs are injected via a credential helper, not embedded in URLs.
- *PII/injection sanitisation* — all agent output passes through `shared/src/sanitize/processor.ts` before storage. Patterns matching prompt-injection phrases, env-dumps, and encoding tricks are quarantined. Content scoring ≥ 0.8 is dropped entirely.
- *Action policy* — agents can only call actions explicitly listed in `profile.actions`. Each call is validated against the `ActionDefinition` schema and written to the append-only audit chain.
- *SSRF defence* — the generic HTTP action handler resolves DNS before fetching and rejects private/loopback/metadata IP ranges including `169.254.169.254`, `10/8`, `172.16/12`, `192.168/16`, `::1`, `fe80::/10`, and `metadata.google.internal`. DNS rebinding is defeated by comparing every A/AAAA record.
- *Network isolation* — pods with `deny-all` or `restricted` network policy have iptables + ip6tables rules applied before the agent starts. With `AUTOPOD_FAIL_CLOSED_FIREWALL=1`, a firewall error aborts the pod rather than leaving the network open.
- *MCP bridge authentication* — each container's MCP calls carry the pod-scoped HMAC token. The daemon validates the token and routes calls only to the correct pod's state.

**Residual risk:**  
A sufficiently sophisticated prompt injection that causes the model to exfiltrate data through an *allowed* action (e.g. a GitHub API call or a Teams webhook) cannot be blocked purely at the network layer. Action definitions should be narrowly scoped in profiles.

---

### T2 — Malicious or compromised skill

**Source:** A skill whose `source.ref` points to a GitHub repo that has been compromised or whose maintainer pushes malicious content.

**Goal:** Execute arbitrary code inside the agent container, exfiltrate tokens, or modify the CLAUDE.md in ways that alter agent behaviour.

**Controls in place:**

- *SHA pinning* — `skill-resolver.ts` validates that `source.ref` is a full 40-character SHA1 commit hash. Branch names, tags, and short SHAs are rejected, preventing a compromised maintainer from pushing to `main` and having it automatically picked up.
- *Fetch timeout* — skill resolution has a 15-second timeout; a slow/malicious server stalls only that pod.
- *Skills are non-fatal* — a resolution failure drops the skill silently rather than aborting the pod, preventing denial-of-service via skill unavailability.

**Residual risk:**  
If the pinned commit itself was already malicious at pin time, or if the GitHub API is compromised, skill content is delivered as-is into the container. There is no content-hash verification on the fetched bytes beyond commit-level integrity. Consider adding a content-hash manifest for high-trust skills.

---

### T3 — Supply-chain attack on base images or build tools

**Source:** A compromised upstream Docker image, npm package, or build tool (e.g. Dagger installer).

**Goal:** Introduce a backdoor into the agent container image that exfiltrates credentials or provides a C2 channel.

**Controls in place:**

- *Image digest pinning* — all base images reference `@sha256:<digest>` rather than floating tags. Digests are sourced from the image-warming pipeline's `image-digests.json` and verified at daemon startup.
- *Dagger pinned install* — the Dagger installer in the Dockerfile uses a pinned version + sha256 checksum rather than `curl | sh`.
- *Registry validation* — `PrivateRegistry.url` fields are validated at profile-write time to reject SSRF targets (same allowlist as T1).

**Residual risk:**  
Digest-pinning defends against tag mutation but not against a compromised image registry that serves a different image for the same digest (collision attack against SHA-256). This is currently considered an acceptable risk given the state of SHA-256 collision resistance.

---

### T4 — Container escape

**Source:** A kernel vulnerability or Docker misconfiguration exploited by a compromised agent.

**Goal:** Break out of the container and access the host filesystem, the Docker socket, or other containers.

**Controls in place:**

- `CapDrop=ALL` — all Linux capabilities dropped at container creation; only the minimal required set is re-added.
- *Seccomp profile* — `seccomp-profile.json` (Docker default + explicit blocks for `unshare`, `setns`, `pivot_root`, `mount`) is applied to every container.
- *Non-root user* — containers run as `autopod:1000` (non-root) inside the container.
- *No Docker socket mount* — the Docker socket is never mounted into agent containers.
- *Network namespace isolation* — each pod gets a dedicated Docker bridge network; iptables rules prevent cross-pod communication.
- *Read-only rootfs* — the agent workspace is a separate mount; the container rootfs is not shared with the host.

**Residual risk:**  
A zero-day kernel or runc vulnerability could bypass all of the above. The seccomp + CapDrop combination significantly raises the bar but is not a complete defence against novel exploits. Consider running containers in a VM-based runtime (gVisor, Kata Containers) for higher-assurance environments.

---

### T5 — Credential exfiltration from the daemon host

**Source:** An attacker who has gained read access to the daemon host filesystem (e.g. via a compromised sidecar, misconfigured volume mount, or stolen SSH key).

**Goal:** Read `~/.autopod/secrets.key` and decrypt all stored credentials.

**Controls in place:**

- *0600 permissions on key file* — the daemon refuses to start if the key file has wider permissions.
- *Key co-location requirement* — the database and key file are on the same host; exfiltrating the ciphertext alone is insufficient.
- *AES-256-GCM authentication* — GCM auth tags detect tampering with ciphertext, but do not prevent read-only exfiltration if both key and ciphertext are stolen.

**Residual risk:**  
If an attacker can read both the key file and the database, all credentials are compromised. This is a deliberate design trade-off (simplicity vs. HSM-grade protection). For high-security deployments, consider storing the key in a hardware HSM or Azure Key Vault with Managed Identity and no daemon-accessible read permission during normal operation. **The key rotation runbook (`docs/secrets-key.md`) must be followed immediately on suspected host compromise.**

---

### T6 — Adversarial PR/CI feedback loop

**Source:** A malicious reviewer, a compromised CI system, or an attacker who can post review comments on the autopod-managed PR.

**Goal:** Cause the auto-merge gate to skip, or inject instructions via review comments that alter the fix-pod's behaviour.

**Controls in place:**

- *`APPROVED` gate* — `approveSession()` checks `reviewDecision` and defers to `merge_pending` unless the PR is explicitly `APPROVED`. A green CI alone is insufficient.
- *PR body Markdown escaping* — all agent-supplied fields (Why, What, How, deviations) are escaped through `escapeMd()` before being sent to GitHub. `@mention`, HTML, link syntax, pipes, and backticks are all neutralised.
- *Fix-pod rate limiting* — `maybeSpawnFixSession()` enforces a 10-minute cooldown between fix-pod spawns and a maximum of 2 fix attempts per PR (`DEFAULT_MAX_PR_FIX_ATTEMPTS`), preventing an adversarial CI loop from spawning unlimited fix pods.

**Residual risk:**  
Review comment content is passed to the fix-pod as part of its task description. A reviewer who posts carefully crafted prompt-injection content in a code review could attempt to influence the fix-pod's behaviour. The sanitiser (T1) provides partial defence; there is no full semantic filter on review comment content.

---

### T7 — Daemon API abuse

**Source:** An authenticated user (valid Entra token) who attempts to abuse the API — e.g. by creating pods with adversarial profile fields, enumerating other users' pods, or calling escalation endpoints for pods they don't own.

**Goal:** Exfiltrate another user's credentials, trigger unintended actions, or exhaust system resources.

**Controls in place:**

- *Rate limiting* — 100 requests/minute per IP (Fastify rate-limit plugin).
- *Profile validation* — Zod schema validates all profile fields at write time; registry URLs are SSRF-checked.
- *Pod HMAC tokens* — MCP calls from containers carry pod-scoped HMAC tokens; the daemon rejects calls for mismatched pod IDs.
- *Query-string token removed* — Bearer header only; query-string `?token=` fallback is gone (prevents token leakage in server logs).

**Residual risk:**  
There are no per-pod ACLs — any authenticated user can read or kill any pod. This is a known gap; per-resource authorisation requires a schema migration and an identity-to-pod ownership model. Track this as a future hardening item.

---

## 5. Residual Risks Summary

| Risk | Severity | Mitigation path |
|---|---|---|
| Allowed action used for data exfiltration by prompt-injected agent | Medium | Narrow action definitions in profiles; add per-action parameter schemas. |
| Skill content-hash not verified beyond commit SHA | Low | Add a content-hash manifest for high-trust skills. |
| No per-pod / per-user ACLs | Medium | Schema migration to add owner column + authorization middleware. |
| Host compromise exposes key + DB = all credentials stolen | High | HSM / Key Vault for key storage; Managed Identity access only at rotation time. |
| Kernel/runc zero-day enables container escape | High | gVisor or Kata Containers for high-assurance environments. |
| Review comment prompt injection into fix-pod | Low-Medium | Semantic filter on review comment content before passing to agent. |
| ACI network policy parity gap | Medium | Implement iptables equivalents in ACI (Azure VNet + NSG rules). |

---

## 6. Out of Scope

- **Anthropic model alignment / safety** — Autopod relies on the model's trained safety behaviour for a first line of defence against many prompt injection scenarios. Model-level concerns are out of scope for this threat model.
- **Daemon operator compromise** — Operators are fully trusted. Insider threat against an operator is a separate problem (credential rotation, audit log review, access control).
- **Physical host access** — Assumed to be secured by the data centre / cloud provider.
