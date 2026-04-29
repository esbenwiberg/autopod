# Practices for Shipping AI-Assisted Code

**Stance.** Code produced by an AI agent is untrusted input. An AI agent with shell access on a dev laptop is an untrusted *insider* with the developer's privileges. Every practice below follows from those two premises.

This document captures how I think about safely letting agents write production code. It is grounded in a real implementation ([Autopod](.)), but the practices port; the tool is replaceable.

---

## Threat Model

The risks I am defending against. None of these are theoretical — most can be demonstrated in under 60 seconds on a stock dev machine. The companion script [`leakhunt.sh`](../leakhunt/leakhunt.sh) enumerates exactly what an agent with shell access walks out the door with.

### Blast radius — what shell access on a dev box buys an attacker

A laptop with a logged-in developer is an order of magnitude more dangerous than a CI runner. The moment an agent gets unconstrained shell, all of the following are in reach:

1. **Credential theft & session hijack.** Env vars, dotfiles (`~/.aws`, `~/.azure`, `~/.config/gh`, `~/.kube`), authenticated CLI sessions, and MSAL refresh tokens that survive password rotation and can mint fresh bearer tokens indefinitely.
2. **Source-code & IP theft.** Every git repo on disk — employer code, side projects, throwaway branches, old commits with leaked secrets — `tar czf` and gone in seconds. Years of IP, one command.
3. **Cloud resource destruction & cost burn.** With `aws`, `az`, `gcloud`, or `kubectl` auth already in place, an agent can drop tables, delete prod, exfil RDS snapshots, spin GPU instances on the developer's bill, or read every secret in every Key Vault in scope.
4. **Supply-chain pivots.** Registry tokens in `~/.npmrc`, `~/.pypirc`, `~/.nuget`, `~/.docker/config.json` → publish a malicious package version as the developer, attacking every CI runner that does `npm install` / `pip install` / `dotnet restore` downstream.
5. **Lateral movement.** SSH private keys + `known_hosts` is a map to every bastion, prod box, and git server the developer can reach.
6. **Session theft via browser data.** Cookies, saved passwords, autofill — bypasses MFA wherever the session is the trust anchor.
7. **Conversation & comms exfil.** Prior AI transcripts (with pasted creds and internal docs), Mail and Messages stores (with reset-password flows and MFA codes), Postman/Insomnia environments stuffed with bearer tokens.

### Agent-specific risks

8. **Prompt injection** via repo content, fetched pages, tool results — hidden instructions that flip the agent against you.
9. **PII leakage** into logs, audit trails, or model context.
10. **Silent regression** — code that compiles and passes obvious checks but breaks the product.
11. **Unbounded loops** — a stuck agent burning money or arguing with itself.
12. **Privilege escalation** — agent reaching beyond the intended task: cloud, repo, infra.
13. **Audit gap** — inability to reconstruct what the agent did, with what inputs, when something goes wrong.

The first set (1–7) is why "just run it in your local shell" is the wrong default. The second set (8–13) is why containerization alone is not sufficient.

If a practice below does not map to one of these, it is ergonomics, not security. Be honest about which is which.

---

## Practices

### 1. Secrets & Credentials
- Credentials encrypted at rest with AES-256-GCM; master key on disk with `0o600`, never logged.
- Purpose-keyed HMAC for any derived signing key — no key reuse across signing contexts.
- Git PATs stripped from remote URLs on every bare-repo clone before agent containers can read them.
- Private-registry credentials injected as build args, never written into image layers.

### 2. Network Isolation
- Per-pod Docker bridge network; no pod-to-pod path even on the same host.
- Three policy modes: `allow-all`, `deny-all`, `restricted` (host:port allowlist).
- Default allowlist covers package registries and model providers. **GitHub is intentionally excluded** so an agent's WebFetch cannot bypass the audited action layer.
- `deny-all` is incompatible with cloud-runtime profiles and rejected at profile validation, not at runtime.

### 3. PII & Prompt-Injection Sanitization
- Eight PII patterns redacted before any agent output is persisted: API keys, AWS keys, Azure connection strings, NuGet passwords, npm tokens, ADO PATs, emails, phone numbers, IPv4.
- Field-name-based redaction on structured payloads (`token`, `password`, `api_key`, …) as defense-in-depth against schema drift.
- Eight prompt-injection patterns scored 0–1: direct override, role manipulation, token-boundary attacks, exfiltration instructions, tool abuse, encoding tricks, XML-tag injection, env-dump.
- **Tiered response**: score < 0.5 passes, 0.5–0.8 is wrapped in `[QUARANTINE]` markers, ≥ 0.8 is hard-blocked. Scanner errors fail closed.
- Markdown escaped in PR bodies — neutralizes @mentions, link syntax, HTML, backticks, and pipes that could mislead human reviewers.

### 4. Pod Tokens & Auth
- HMAC-SHA256 short-lived tokens, 24h default TTL, scoped to a single pod.
- Verification uses `timingSafeEqual` — never plain string comparison.

### 5. Container Isolation
This is the single most important practice. Containerization is what makes blast-radius risks 1–7 inapplicable: the agent never sees host dotfiles, SSH keys, browser data, Mail/Messages, prior AI transcripts, or authenticated CLI sessions. It runs only against an explicit, narrow set of mounted artifacts (the worktree, the bare repo with PATs stripped, injected skills).

- Every agent container runs as non-root `autopod` (uid 1000); the Dockerfile always ends with `USER autopod`.
- Memory cap enforced per pod (10 GB default, profile-overridable).
- Code-intelligence tooling installed read-only under the agent's home.
- No host dotfiles, no SSH agent forwarding, no Docker socket mount, no host CLI sessions.

### 6. State Machine
- Explicit state graph; every status update goes through `validateTransition()` before persistence.
- Two terminal states (`complete`, `killed`). Everything else can be force-killed.
- Behavioral guards (`canKill`, `canPause`, `canPromote`, `canFail`) checked at the call site, not buried in the storage layer.

### 7. Validation Gates
- Multi-phase: build → health check → smoke (Playwright) → AI task review. Each phase persists its own result.
- Build logs capped at 10k chars; diffs at 50k. Back-pressure against context bombs.
- Up to three validation attempts; each failure feeds *correction context*, not a blind retry.

### 8. Escalation Contract (Agent ↔ Control Plane)
A fixed, audited surface. Agents only get these tools — nothing implicit:

| Tool | Purpose |
|------|---------|
| `ask_human` | Synchronous escalation; blocks until human responds. |
| `ask_ai` | Second opinion from another model; rate-limited. |
| `report_plan` | Pre-implementation plan, fire-and-forget. |
| `report_progress` | Phase transition signal. |
| `report_blocker` | Blocking issue; auto-pauses pod past a threshold. |
| `report_task_summary` | Final summary including deviations from plan. |
| `validate_in_browser` | Playwright proof; server enforces localhost-only URLs. |
| `execute_action` | Control-plane actions (Azure/ADO/GitHub/HTTP), dynamically registered per profile, every call audited. |
| `request_credential` | Human approves; the token never enters the agent's context. |
| `check_messages` | Async human messaging. |
| `memory_list`, `memory_read`, `memory_search` | Scoped memory access (global/profile/pod). |
| `memory_suggest` | Agent proposes; human approves before storage. |
| `trigger_revalidation` | Workspace-pod-only handoff to a failed worker pod. |

### 9. Action Control Plane (ACP)
The agent never calls cloud or DevOps APIs directly. Every state-changing operation goes through a registered, parameter-validated handler — and the response runs back through the same sanitization pipeline as agent output. This is the direct defense against cloud-resource destruction (threat #3) and one of the layered defenses against credential theft (threat #1).

- Every action is an explicit `ActionDefinition` with a handler (Azure, ADO, GitHub, Azure logs, Azure PIM, deploy, test-pipeline, generic HTTP). Required params validated, optional params defaulted, no free-form parameter surface.
- Agents request actions via the `execute_action` MCP tool; raw `az`, `aws`, `gcloud`, `kubectl`, `gh` are not installed in agent containers.
- **Same PII + prompt-injection sanitization as agent output.** Every action response is processed by `processContentDeep` — the same patterns, the same quarantine tiers, the same fail-closed behaviour. Cloud responses get exactly as much trust as model output.
- **SSRF guard** on the generic HTTP handler — `assertPublicUrl` rejects private, loopback, and cloud-metadata addresses by default. An action profile cannot accidentally turn the daemon into a confused deputy against `169.254.169.254`.
- **Resource allowlists.** Each action override carries `allowedResources` patterns (e.g. `org/project@repo@`); the engine rejects a call against any resource that doesn't match. Granting "merge PR in repo X" doesn't grant "merge PR in repo Y."
- **Per-action approval gating.** Overrides can require human approval before execution. The MCP layer enforces it; the engine errors loudly if a request reaches it with the approval flag bypassed.
- **Multiple overrides merge, not first-match.** Granting access to several specific resources composes correctly instead of silently dropping all but the first.

### 10. Action Audit Trail
- Hash-chained: each entry's SHA-256 incorporates the previous entry, making the chain tamper-evident.
- Insert-only API. No update or delete path exists, even for operators.
- Every entry tags PII detection and quarantine score from the ACP pipeline above for forensic replay.
- Failed actions are audited too — error message truncated, params sanitized — so a denied or crashed action is just as observable as a successful one.

### 11. Profile-Based Configuration
- Zod-validated profiles own everything that is not per-task: registries, network policy, model provider, escalation rules, skills, MCP servers, actions.
- Inheritance chain capped at depth 5 to prevent circular extension.
- Field-level merge strategy (replace vs. inherit). A small set of fields — `name`, `extends`, timestamps — never inherit.

### 12. Skill & MCP Injection
Both skills and MCP servers are *capabilities* the agent gets — and both follow the same rule: explicit, named, declared up front. The agent cannot invent either.

**Skills**
- Skills load from local files or GitHub *commit SHA*. **Branches and tags rejected** so a force-push can't change agent behavior.
- Skill content runs through the same PII + injection pipeline as agent output.
- Failures are non-fatal: skip the skill, log it, never block the pod.

**MCP servers**
- Configured at the daemon level (applies to all pods) or the profile level (repo-scoped). Merge keyed by server name.
- Two transports: **HTTP** (the daemon proxies the URL into the container; auth headers are injected by the proxy at request time and never enter the agent's context) and **stdio** (a local binary spawned inside the container; written to `.mcp.json`).
- Tool names declared up front via `toolNames`; surfaced to the agent as `ToolSearch select:` hints so the agent loads schemas explicitly instead of stumbling into them. No implicit tool discovery.
- Agents can't add MCP servers. The set is fixed at pod provisioning.

### 13. Commit & PR Hygiene
- Heuristic conventional-commit messages generated from the actual diff.
- PR title normalized to `feat:/fix:/chore:` prefix, capped at 70 chars.
- PR body assembled from pod context (task, profile, validation, screenshots, summary). Agent narrative is escaped, not raw.
- Commit + push after every phase. No batched megapushes.

### 14. Bounded Retries
- PR fix attempts capped (default 2; raisable for manual spawns).
- Validation attempts capped (default 3).
- Reconciler re-queue capped so a stuck pod can't loop forever.

### 15. Migration Discipline
- Sequential numeric prefixes. Collisions are silent (the runner skips the second one forever), so the rule is absolute: **never reuse a number**.

### 16. Other Enforced Practices
- **Model-provider abstraction.** Runtime selected per provider (Anthropic API, Max/Pro OAuth, Foundry, Copilot). OAuth-backed providers refresh on every resume — stale tokens never used.
- **Event retention.** System events pruned after 30 days.
- **Bare repo + worktree.** One bare clone per repo; worktrees per pod. No per-pod credentials, faster spawns.
- **Screenshot compression.** 80% quality cap on stored images.
- **Memory index cap.** 100 entries surfaced; full content fetched on demand.
- **Validation overrides.** Humans can dismiss recurring findings; the dismissal is itself a stored, auditable decision.

---

## What I Deliberately Don't Do

- **No agent-defined tools.** Every capability is registered out of band, not requested by the agent.
- **No implicit credentials.** Agents never see raw tokens. They request, the human approves, the daemon executes.
- **No batched audit writes.** Audit entries land before the action returns to the agent. If the audit write fails, the action fails.
- **No "trust the model."** Sanitization runs on output from every model. Capability isn't alignment.
- **No optional sanitization.** Fail-closed is the default. Scanner error means the content is blocked, not allowed.
- **No mutable refs in supply chain.** Skills, images, and dependencies pin to immutable identifiers (commit SHAs, digests) wherever possible.
- **No silent retries.** A retry is either bounded with feedback or not a retry — it's a loop bug.
- **No raw cloud CLIs in agent containers.** Cloud and DevOps changes go through `execute_action` against registered, audited handlers. `az`, `aws`, `gcloud`, `kubectl`, `gh` are not available to the agent — and even if they were, the network policy and lack of mounted credentials would stop them. This is the direct defense against cloud resource destruction (threat #3).
- **No mounted SSH keys, no agent forwarding.** Lateral movement (threat #5) requires keys; the agent has none. Git access goes through the bare repo with PATs already stripped.
- **No multi-repo access.** A pod sees the worktree it was created for, not the rest of the developer's filesystem. IP theft (threat #2) requires `tar czf ~/repos`; that path doesn't exist inside the container.

---

## How to Read This

Each section above is a *practice*, not an implementation detail. Where a practice references a behavior, the source of truth is the code in this repo — every claim here maps to a file and is enforced at runtime, not by convention.

The practices apply whether or not you use Autopod. If you ship AI-assisted code from a local shell, the same threat model holds; the only thing that changes is which of these you have to enforce by hand.
