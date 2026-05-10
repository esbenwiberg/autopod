# Just-In-Time Credential Vending for Autopod Pods

> **Goal:** Give autopod pods temporary, scoped access to arbitrary services (GitHub, Azure, AWS, databases, APIs) with automatic expiry — "access X, with Y permissions, for Z minutes."
>
> **Date:** 2026-03-20

---

## TL;DR — The Three Viable Architectures

| Approach | Complexity | Best When |
|----------|-----------|-----------|
| **A) Vault + K8s Auth** | Medium | You want dynamic secrets for multiple services without a full identity mesh |
| **B) SPIFFE/SPIRE + Vault** | High | You need cross-cloud universal identity with zero static secrets |
| **C) Proxy Sidecar (mitmproxy/Secretless)** | Low-Medium | You want the pod to never touch credentials at all (prompt injection defense) |

**Our recommended starting point:** Start with **A**, add **C** as a sidecar layer, evolve toward **B** if we go multi-cloud.

---

## 1. GitHub Token Minting

### GitHub App Installation Tokens (The Answer)

The gold standard for programmatic short-lived GitHub credentials.

**How it works:**
1. Register a GitHub App with desired permissions (50+ granular scopes)
2. Generate a JWT signed with the App's RSA private key (RS256, 10min validity)
3. Exchange JWT for an installation access token via `POST /app/installations/{id}/access_tokens`
4. Token is scoped to specific permissions AND specific repos

**Key properties:**
- **TTL:** 1 hour (non-renewable, mint a new one)
- **Scoping:** Both `permissions` and `repositories` can be narrowed at mint time
- **Rate limits:** New limits since Feb 2024 on scoped token creation

**Fine-grained PATs cannot be created via API** — this is a known gap. GitHub's [roadmap item #350](https://github.com/github/roadmap/issues/350) for Service Tokens hasn't shipped yet (since 2021).

**GitHub Actions OIDC** is locked to Actions runners — can't use it from external systems to get GitHub tokens. It's one-directional (GitHub -> cloud providers).

### Tools & Repos for GitHub Token Vending

| Project | What It Does | Link |
|---------|-------------|------|
| **vault-plugin-secrets-github** | Vault secrets engine that mints 1hr scoped GitHub App installation tokens. Stores private key in Vault's encrypted storage. Includes `hashed_token` for audit log correlation. | [martinbaillie/vault-plugin-secrets-github](https://github.com/martinbaillie/vault-plugin-secrets-github) |
| **github-token-manager** | K8s operator for ephemeral GitHub tokens. Like cert-manager but for GitHub. Auto-rotating 1hr tokens. KMS integration for private key storage. | [isometry/github-token-manager](https://github.com/isometry/github-token-manager) |
| **External Secrets Operator** | K8s operator with `GithubAccessToken` generator that mints installation tokens from App credentials stored as K8s secrets. | [external-secrets.io](https://external-secrets.io/latest/api/generator/github/) |
| **actions/create-github-app-token** | Official GitHub Action. Mints installation tokens with scoped `permissions` and `repositories`. Auto-revokes in post step. | [actions/create-github-app-token](https://github.com/actions/create-github-app-token) |
| **ghtkn** | CLI for short-lived GitHub tokens for local dev. Uses Device Flow for 8hr user access tokens. OS keyring integration. | [suzuki-shunsuke/ghtkn](https://github.com/suzuki-shunsuke/ghtkn) |
| **superfly/tokenizer** | HTTP proxy that injects third-party credentials into requests. Stateless — clients encrypt secrets with proxy's public key. By Fly.io. | [superfly/tokenizer](https://github.com/superfly/tokenizer) |
| **git-credential-github-app** | Git credential helper that transparently mints 1hr installation tokens. | [bdellegrazie/git-credential-github-app](https://github.com/bdellegrazie/git-credential-github-app) |

---

## 2. Azure JIT Credentials

### Workload Identity Federation (Best Option)

External workloads present an OIDC token to Microsoft Entra ID. Entra checks it against a pre-configured Federated Identity Credential (issuer + subject + audience match). Returns a ~1hr Azure access token. **No secret material involved.**

**Key facts:**
- Any OIDC-compliant issuer works (publicly reachable `/.well-known/openid-configuration`)
- Max 20 federated identity credentials per App Registration
- **Flexible FICs (Preview):** Wildcard/expression-based subject matching (e.g., `claims['sub'] matches 'repo:contoso/*'`)
- Permissions scoped via Azure RBAC at any level (management group -> individual resource)

### Azure PIM (Privileged Identity Management)

Fully automatable JIT access via Microsoft Graph API:
- `POST /roleManagement/directory/roleEligibilityScheduleRequests` — create eligible assignments
- `POST /roleManagement/directory/roleAssignmentScheduleRequests` with `action: "selfActivate"` — activate for bounded time
- Max 8hr activation, can require justification/ticket/approval

### HashiCorp Vault Azure Secrets Engine

Creates entirely new Service Principals on-demand, assigns RBAC roles, auto-deletes on lease expiry. Each consumer gets unique `client_id` + `client_secret`. Vault itself authenticates via Workload Identity Federation.

### Azure-Specific Tools

| Project | What It Does | Link |
|---------|-------------|------|
| **Azure AAD Auth Proxy** | Microsoft's own HTTP proxy sidecar. Injects `Authorization: Bearer <token>` into requests. Authenticates via `DefaultAzureCredential`. | [Azure/aad-auth-proxy](https://github.com/Azure/aad-auth-proxy) |
| **Azure Workload Identity** | Mutating webhook + proxy sidecar for AKS. Injects env vars and intercepts IMDS calls. | [azure/azure-workload-identity](https://azure.github.io/azure-workload-identity/docs/) |
| **akv2k8s** | Azure Key Vault to K8s. Controller syncs secrets; Env Injector injects them as env vars without disk. | [SparebankenVest/azure-key-vault-to-kubernetes](https://github.com/SparebankenVest/azure-key-vault-to-kubernetes) |
| **Adobe aio-tvm** | Token Vending Machine for Azure Blob/Cosmos. Delivers scoped, temporary SAS tokens. | [adobe/aio-tvm](https://github.com/adobe/aio-tvm) |

---

## 3. Universal Credential Vending Machines

### HashiCorp Vault (The Swiss Army Knife)

Most mature credential vending machine. Dynamic secrets engines for everything:

| Engine | What It Generates | TTL |
|--------|------------------|-----|
| AWS | IAM users, STS AssumeRole, federation tokens | Configurable |
| Azure | Dynamic Service Principals with RBAC | Configurable |
| GCP | OAuth tokens, service account keys | Configurable |
| Database | Ephemeral DB users (Postgres, MySQL, Mongo, MSSQL, etc.) | Configurable |
| GitHub | Installation tokens (community plugin) | 1 hour |
| PKI | Short-lived X.509 certificates | Configurable |
| SSH | Signed SSH certificates | Configurable |
| Kubernetes | Short-lived K8s service account tokens | Configurable |

**Community plugins** extend to GitLab, Artifactory, Jenkins, Vercel, Fastly, and more.
Full list: [giuliocalzo/vault-plugin-list](https://github.com/giuliocalzo/vault-plugin-list)

### SPIFFE/SPIRE (Universal Workload Identity)

Not a credential vending machine directly, but the **identity substrate** on which vending is built.

1. SPIRE attests workload (verifies it is what it claims via kernel/container/cloud metadata)
2. Issues short-lived JWT-SVID with workload's SPIFFE ID
3. JWT-SVID can be exchanged for:
   - AWS credentials (via `AssumeRoleWithWebIdentity`)
   - Azure tokens (via Workload Identity Federation)
   - Vault secrets (via JWT/OIDC auth)
   - Any OIDC-compatible service

### Other Notable Tools

| Project | What It Does | Link |
|---------|-------------|------|
| **Teleport** | Issues short-lived certs (1-12hr) for SSH, K8s, databases, web apps. JIT Access Requests with approval workflows. Machine ID (`tbot`) for non-human workloads. | [gravitational/teleport](https://github.com/gravitational/teleport) |
| **Infisical** | Open-source secrets platform with time-bound access, auto-revocation, dynamic credentials, PKI, SSH certs. | [Infisical/infisical](https://github.com/Infisical/infisical) |
| **hoop.dev** | Open-source access proxy with JIT reviews (Slack/Teams approval), AI data masking, audit. | [hoophq/hoop](https://github.com/hoophq/hoop) |
| **Abbey Labs** | Terraform-native JIT access. Define workflows as Grant Kits, auto-revoke on expiry. | [abbey.io](https://www.abbey.io/) |
| **Conjur** | Open-source secrets manager with RBAC and Secretless Broker sidecar. | [conjur.org](https://www.conjur.org/) |

---

## 4. The Proxy Pattern (Pods Never Touch Credentials)

This is the **big insight** — instead of giving pods tokens, route traffic through a proxy that injects auth. The pod literally cannot leak what it doesn't have.

### Three Tiers of Sophistication

**Tier 1 — Simple: mitmproxy + network isolation**
- Agent container runs with `--network none`
- Connects only via Unix socket to mitmproxy on host
- Proxy injects credentials, enforces domain allowlists, logs everything
- **This is what Anthropic uses for Claude Code deployments**

**Tier 2 — Medium: Envoy sidecar + Vault + OPA**
- Envoy `ext_authz` filter calls OPA for per-request policy decisions
- Vault Agent sidecar provides rotating credentials
- Kubernetes-native, battle-tested at scale

**Tier 3 — Full: MCP Gateway + Zanzibar + SPIRE**
- AgentGateway or Docker MCP Gateway as the chokepoint
- Cedar/OPA policies for tool-level authorization
- SpiceDB/OpenFGA for relationship-based permissions
- SPIRE for workload identity

### Proxy/Sidecar Tools

| Project | Pattern | Link |
|---------|---------|------|
| **CyberArk Secretless Broker** | Sidecar that intercepts TCP connections, injects credentials. Supports HTTP, PostgreSQL, MySQL, SSH, AWS IAM. Agent connects to localhost with zero auth. | [cyberark/secretless-broker](https://github.com/cyberark/secretless-broker) |
| **Azure AAD Auth Proxy** | Microsoft's sidecar that adds Azure auth headers to outbound requests. | [Azure/aad-auth-proxy](https://github.com/Azure/aad-auth-proxy) |
| **Pomerium** | Zero-trust proxy with MCP server security support. Continuously verifies identity, mints scoped JWTs. | [pomerium/pomerium](https://github.com/pomerium/pomerium) |
| **superfly/tokenizer** | Stateless HTTP proxy. Clients encrypt secrets with proxy's public key; proxy decrypts and injects auth headers. | [superfly/tokenizer](https://github.com/superfly/tokenizer) |
| **oauth2-client-credentials-sidecar** | Sidecar handling OAuth2 Client Credentials grant on outbound API calls. Auto-refreshes tokens. | [surfkansas/oauth2-client-credentials-api-sidecar](https://github.com/surfkansas/oauth2-client-credentials-api-sidecar) |
| **stakater/ProxyInjector** | K8s controller that auto-injects auth proxy sidecar into pods. | [stakater/ProxyInjector](https://github.com/stakater/ProxyInjector) |

---

## 5. Fine-Grained Authorization (Action-Level Permissions)

Instead of "this pod has access to GitHub," we want "this pod can create PRs on repo X but not delete branches."

### Policy Engines

| System | Approach | Link |
|--------|----------|------|
| **OPA (Open Policy Agent)** | Rego policies evaluated as Envoy sidecar. Per-request decisions based on method, path, headers, JWT claims. Note: Apple acquired maintainers Aug 2025 — future uncertain. | [openpolicyagent.org](https://www.openpolicyagent.org/) |
| **Cedar** | Amazon's policy language. Used by AgentGateway for tool-level RBAC on MCP servers. Supports RBAC + ABAC + ReBAC. | [cedarpolicy.com](https://www.cedarpolicy.com/) |
| **Gravitee MCP Proxy** | Operates at MCP protocol level. ACL policies per MCP method (`tools/list`, `tools/call`). | [gravitee.io](https://www.gravitee.io/blog/mcp-proxy-unified-governance-for-agents-tools) |

### Zanzibar-Style Permission Systems (Relationship-Based)

Model authorization as a graph: "agent:pod-abc is viewer of repo:my-repo" — then check "can pod-abc create_pr on repo:my-repo?"

| System | Notes | Link |
|--------|-------|------|
| **SpiceDB** | Most mature Zanzibar implementation. Centralized service, gRPC API. | [authzed/spicedb](https://github.com/authzed/spicedb) |
| **OpenFGA** | CNCF project (originally Auth0/Okta). Combines ReBAC + ABAC. | [openfga.dev](https://openfga.dev/) |
| **Permify** | Open-source, multi-tenant focused. Acquired by FusionAuth. | [Permify/permify](https://github.com/Permify/permify) |

---

## 6. AI-Agent-Specific Solutions (Emerging 2025-2026)

This space is exploding. Purpose-built tools for exactly our use case:

| Project | What It Does | Link |
|---------|-------------|------|
| **Akeyless SecretlessAI** | JIT secrets provisioning for AI agents. MCP Identity Gateway. "Blended Identity" (agent acts on behalf of verified user). Launched Oct 2025. | [akeyless.io](https://www.akeyless.io/secure-ai-agents/) |
| **Aembit IAM for Agentic AI** | Workload IAM for AI agents. Trust providers attest agent runtime. Policy engines evaluate context (time, env, geo). Dynamic credential flows. | [aembit.io](https://aembit.io/) |
| **Composio** | Managed OAuth + brokered credentials for 1000+ apps. LLM decides *what*, broker handles *how* (auth). Multi-tenant token management. | [composio.dev](https://composio.dev) |
| **Auth0 for AI Agents** | Enterprise auth for agents with async approval workflows. GA Oct 2025. | [auth0.com](https://auth0.com/blog/access-control-in-the-era-of-ai-agents/) |
| **Okta Cross App Access (XAA)** | New open protocol extending OAuth for agent-to-app access. Early Access Jan 2026. | [okta.com](https://www.okta.com/blog/ai/securing-ai-agents-enterprise-blueprint/) |
| **AgentGateway** | Linux Foundation. Next-gen agentic proxy with Cedar policies for tool-level authorization. | [agentgateway/agentgateway](https://github.com/agentgateway/agentgateway) |
| **Docker MCP Gateway** | Docker MCP CLI plugin / MCP Gateway for containerized agents. | [docker/mcp-gateway](https://github.com/docker/mcp-gateway) |

### OWASP Guidance for AI Agent Security
- Per-tool permission scoping
- Separate tool sets for different trust levels
- JIT ephemeral tokens
- Human-in-the-loop for high-impact actions
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)

---

## 7. Token Exchange Protocol (RFC 8693)

The protocol-level answer to "how does a pod with identity X get credentials for service Y."

Client sends `subject_token` (what I have) + `requested_token_type` (what I want) + `audience` (who it's for) to an STS. Returns a new token.

**Implementations:** Dex, ZITADEL, Ory Hydra, Keycloak, Authlete

---

## 8. Proposed Architecture for Autopod

```
┌─────────────────────────────────────────────────────┐
│  Autopod Pod                                         │
│  ┌──────────┐  ┌─────────────────────────────────┐  │
│  │  Agent    │──│ Credential Proxy Sidecar        │──┼──→ GitHub API
│  │  Process  │  │ (injects tokens, enforces scope)│  │──→ Azure APIs
│  │  (no creds│  │                                 │  │──→ Databases
│  │   at all) │  │  Policy: OPA/Cedar              │  │──→ Other APIs
│  └──────────┘  └────────────┬────────────────────┘  │
│                              │                       │
└──────────────────────────────┼───────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Vault              │
                    │  - GitHub engine    │
                    │  - Azure engine     │
                    │  - AWS engine       │
                    │  - DB engines       │
                    │  Auth: K8s SA token │
                    └─────────────────────┘
```

### Implementation Phases

**Phase 1 — GitHub tokens via Vault (lowest friction)**
- Deploy `vault-plugin-secrets-github` with our GitHub App credentials
- Pod authenticates to Vault via K8s service account
- Vault mints 1hr scoped GitHub installation tokens
- Pod gets `contents:read` + `pull_requests:write` on specific repos only

**Phase 2 — Azure via Workload Identity Federation**
- Configure Federated Identity Credentials on App Registrations
- Pod's K8s SA token (with OIDC discovery) is exchanged for Azure tokens
- Scoped RBAC at resource group level

**Phase 3 — Proxy sidecar for zero-credential pods**
- Add Secretless Broker or custom mitmproxy sidecar
- Agent code makes unauthenticated requests to localhost
- Proxy handles all credential injection + policy enforcement
- Prompt injection can't leak what the agent doesn't have

**Phase 4 — Fine-grained authorization**
- OPA or Cedar policies for per-action permissions
- "Pod X can POST to `/repos/Y/pulls` but not DELETE anything"
- OpenFGA for relationship-based permission modeling

---

## 9. Key Decisions to Make

| Decision | Options | Trade-off |
|----------|---------|-----------|
| **Vault vs. direct federation** | Vault adds a layer but unifies everything; direct federation is simpler per-service | Vault = more ops, but one interface for all services |
| **Sidecar proxy vs. SDK** | Proxy means zero credential code in agent; SDK is simpler to deploy | Proxy is more secure (prompt injection defense), SDK is faster to ship |
| **SPIFFE vs. K8s SA tokens** | SPIFFE is universal but complex; K8s SA tokens work if we stay on K8s | Only go SPIFFE if multi-cloud is real |
| **OPA vs. Cedar** | OPA is mature but Apple acquired maintainers; Cedar is AWS-backed, newer | Cedar has better DX; OPA has bigger ecosystem |
| **Self-hosted vs. SaaS** | Akeyless/Aembit/Composio handle everything; self-hosted gives control | SaaS = faster, self-hosted = cheaper at scale |

---

## 10. Wild Ideas Worth Exploring

- **MCP as the permission boundary** — Expose services as MCP tools with per-tool authorization (AgentGateway + Cedar). Pod doesn't hit APIs directly; it calls MCP tools that are individually permissioned.
- **Token vending as an MCP tool** — Build an MCP server that vends credentials. Pod calls `request_github_token(repo: "X", permissions: ["contents:read"], ttl: "30m")` and gets a scoped token back.
- **Blended Identity (Akeyless pattern)** — Agent acts on behalf of a verified user. The credential encodes both "who is the agent" and "who authorized this action."
- **Approval-gated escalation** — Pod has basic read access by default. When it needs write access, it requests escalation via PIM/Teleport/hoop.dev, waits for approval (Slack/Teams), then gets time-bounded elevated permissions.
