# Action Control Plane, PII Stripping & Pod Awareness

## Context

Autopod pods currently operate in a sandbox but have no structured way to access external context (issues, work items, PRs, logs). Agents try to `curl` the internet and fail. The alternative — giving agents raw API tokens — risks token leakage via prompt injection and makes PII stripping impossible since the agent gets raw API responses.

**Architecture decision:** Build a **hybrid action control plane** where read operations are exposed as MCP tools (daemon fetches data, strips PII, returns sanitized results) and git write operations stay as-is (session manager handles push/PR). The agent never touches an API token for read operations.

**Why this beats token vending:**
- Zero token exposure — nothing to leak via prompt injection
- PII stripping is built-in at the action layer (we control every response)
- Surgical audit trail — we know exactly which issue/workitem was read
- Network isolation is trivial — agent only talks to localhost MCP server
- Consistent interface — `read_workitem` works the same for GitHub Issues and Azure DevOps

---

## Action Catalog (MVP)

### GitHub Actions
| Action | Params | Returns (PII-stripped) |
|--------|--------|----------------------|
| `read_issue` | repo, issue_number | title, body, state, labels, comments count |
| `search_issues` | repo, query, state?, labels?, max_results? | list of issue summaries |
| `read_issue_comments` | repo, issue_number, max_results? | list of comment bodies (authors masked) |
| `read_pr` | repo, pr_number | title, body, state, files changed, merge status |
| `read_pr_comments` | repo, pr_number, max_results? | review comments (authors masked) |
| `read_pr_diff` | repo, pr_number, file_path? | diff content (emails in diff headers masked) |
| `read_file` | repo, path, ref? | file content from another repo (not the worktree) |
| `search_code` | repo, query, max_results? | matching file snippets |

### Azure DevOps Actions
| Action | Params | Returns (PII-stripped) |
|--------|--------|----------------------|
| `read_workitem` | org, project, workitem_id | title, description, state, type, tags, acceptance criteria |
| `search_workitems` | org, project, query, state?, type?, max_results? | list of workitem summaries |

### Azure Observability Actions
| Action | Params | Returns (PII-stripped) |
|--------|--------|----------------------|
| `query_logs` | workspace_id, query (KQL), timespan? | Log Analytics query results (IPs/emails masked) |
| `read_app_insights` | app_id, query (KQL), timespan? | Application Insights results |
| `read_container_logs` | resource_group, container_app, timespan?, filter? | Container Apps console logs |

### Context Enrichment Actions
| Action | Params | Returns (PII-stripped) |
|--------|--------|----------------------|
| `enrich_context` | query, source? | Enriched context from external service (PII stripped) |

---

## MCP Proxy: Solving the Network Isolation Gap

### The Problem

Injected MCP servers (`profile.mcpServers`) currently pass their raw URLs to the agent (line 219 of session-manager.ts). The agent calls these URLs directly. But if `networkPolicy.enabled: true`, the container is firewalled — the agent **cannot reach external MCP servers**.

The escalation MCP works because its URL points to the daemon's own HTTP server (`http://daemon-host:3100/mcp/{sessionId}`), which is reachable from the container's Docker network.

### The Solution: Daemon as MCP Proxy

Route ALL injected MCP server traffic through the daemon:

```
Agent → http://daemon:3100/mcp-proxy/{serverName}/{sessionId}
                    ↓
            Daemon (proxy layer)
            ├── Auth injection (headers from InjectedMcpServer.headers)
            ├── PII stripping on responses (sanitizeDeep)
            ├── Audit logging (which tools called, by which session)
            ├── Rate limiting
            └── Timeout enforcement
                    ↓
            Actual MCP Server (wherever it lives — internet, internal, etc.)
```

**How it works:**
1. At session provisioning, the daemon rewrites `InjectedMcpServer.url` to point to the daemon's proxy endpoint instead of the actual server URL
2. Agent calls the proxy URL — the daemon forwards to the real server
3. Daemon injects `InjectedMcpServer.headers` (auth tokens etc.) into the forwarded request
4. Response is PII-stripped before returning to agent
5. All calls are audit-logged

**Benefits:**
- Agent needs ZERO external network access (only reaches daemon on Docker network)
- PII stripping on MCP responses — same sanitization as action tools
- Audit trail for all MCP tool calls
- Centralized auth — MCP server credentials live in the daemon, not the pod
- Your context enrichment MCP service works automatically through the proxy

**Implementation:**
- **`packages/daemon/src/api/mcp-proxy-handler.ts`** — New Fastify route handler at `/mcp-proxy/:serverName/:sessionId`
- **`packages/daemon/src/sessions/session-manager.ts`** — At line 219, rewrite injected MCP server URLs to proxy URLs
- The proxy uses `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` to forward requests

### Context Enrichment Service Integration

Your existing context enrichment service (API or MCP) plugs in two ways:

**As a proxied MCP server (if it's already MCP):**
```json
{
  "mcpServers": [{
    "name": "context-enrichment",
    "url": "https://your-enrichment-service.azurewebsites.net/mcp",
    "headers": { "Authorization": "Bearer ${ENRICHMENT_API_KEY}" },
    "description": "Enriches task context with domain knowledge",
    "toolHints": ["Use enrich_context to get additional context about the codebase and domain"]
  }]
}
```
Agent calls it via the MCP proxy. Daemon handles auth + PII stripping automatically.

**As an action handler (if it's a REST API):**
Add a `context-enrichment` action group with an `enrich_context` action handler that calls your API. Same pattern as GitHub/ADO handlers.

---

## Research Pods: Web-Crawling Mode

### The Problem

Some pods need to crawl the web for research — fundamentally different from coding pods:
- They NEED internet access
- They DON'T produce code (no git, no build, no validation)
- They produce a REPORT (not a PR)

### The Solution: Profile-Level Mode

Research pods are a profile configuration concern, not a new system. The existing session manager + network policy handles it with two additions:

**1. Relaxed network policy with guardrails:**
```json
{
  "name": "research-pod",
  "networkPolicy": {
    "enabled": true,
    "allowedHosts": [
      "*.github.com", "*.stackoverflow.com", "arxiv.org",
      "*.medium.com", "*.dev.to", "*.npmjs.com", "pypi.org"
    ],
    "replaceDefaults": true
  }
}
```

Still firewalled (not full open internet), but with a generous domain allowlist for research-relevant sites. Always block:
- Cloud metadata endpoints (`169.254.169.254`) — prevent SSRF
- Internal service endpoints
- Known credential endpoints

**2. New `outputMode` field on Profile:**
```typescript
interface Profile {
  // ... existing fields ...
  outputMode: 'pr' | 'artifact';  // default: 'pr'
}
```

- `pr` (default): Current behavior — collect diff, validate, create PR
- `artifact`: Agent writes output to a designated file (e.g., `research-output.md`). Session manager collects it as an artifact. No build, no validation, no PR.

**3. Skip validation:**
Use the existing `skipValidation` session option. Research profiles set this by default.

**4. Safety layers for web access:**
- **Content size limits** in the egress proxy — cap response bodies (prevent downloading huge files)
- **Rate limiting** on outbound connections (prevent pod being used as DDoS vector)
- **PII stripping on output** — the research report goes through `sanitizeDeep()` before being stored/shared
- **Action tools still available** — research pods can also use `read_issue`, `search_code` etc. for structured data alongside raw web access

**Example research profile:**
```json
{
  "name": "research-pod",
  "template": "node22",
  "executionTarget": "local",
  "networkPolicy": {
    "enabled": true,
    "allowedHosts": ["*.github.com", "*.stackoverflow.com", "arxiv.org", "*.medium.com"],
    "replaceDefaults": true
  },
  "actionPolicy": {
    "enabledGroups": ["github-issues", "github-code"],
    "sanitization": { "preset": "standard" }
  },
  "outputMode": "artifact",
  "buildCommand": "echo 'no build'",
  "startCommand": "echo 'no server'",
  "customInstructions": "Write your research findings to research-output.md in the workspace root."
}
```

---

## Phase 1: Types, Schemas & Action Framework

### Shared types

**`packages/shared/src/types/actions.ts`** — New file:
```typescript
/** Defines what actions a profile's pods can use */
interface ActionPolicy {
  /** Which action groups are enabled */
  enabledGroups: ActionGroup[];
  /** Per-action overrides (e.g., restrict read_file to specific repos) */
  actionOverrides?: ActionOverride[];
  /** PII sanitization config applied to all action responses */
  sanitization: DataSanitizationConfig;
}

type ActionGroup = 'github-issues' | 'github-prs' | 'github-code'
                 | 'ado-workitems' | 'azure-logs' | 'context-enrichment';

interface ActionOverride {
  action: string;           // e.g. 'read_file'
  allowedResources?: string[]; // e.g. ['myorg/myrepo', 'myorg/shared-lib']
  denied?: boolean;         // explicitly block this action
  requiresApproval?: boolean; // needs human approval before execution
}

interface DataSanitizationConfig {
  preset: 'strict' | 'standard' | 'relaxed';
  patterns?: {
    emails?: boolean;      // default: true
    phones?: boolean;      // default: true (strict), false (standard)
    apiKeys?: boolean;     // default: true
    authorFields?: boolean; // default: true — mask author/createdBy names
    ipAddresses?: boolean; // default: true (strict), false (standard/relaxed)
  };
  /** Domains to NOT mask (e.g., 'example.com' for test fixtures) */
  allowedDomains?: string[];
}
```

**`packages/shared/src/types/profile.ts`** — Add to `Profile`:
```typescript
actionPolicy: ActionPolicy | null;
outputMode: 'pr' | 'artifact'; // default: 'pr'
```

**`packages/shared/src/schemas/profile.schema.ts`** — Zod schemas for `actionPolicySchema`, `actionGroupSchema`, `actionOverrideSchema`, `dataSanitizationSchema`. Added to `createProfileSchema` with `.nullable().default(null)`. Add `outputMode` with `.default('pr')`.

### Action execution types

**`packages/shared/src/types/actions.ts`** — Also include:
```typescript
interface ActionRequest {
  action: string;
  params: Record<string, unknown>;
  sessionId: string;
}

interface ActionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  sanitized: boolean; // flag so agent knows PII was stripped
}

interface ActionAuditEntry {
  sessionId: string;
  action: string;
  params: Record<string, unknown>; // sanitized copy
  outcome: 'success' | 'denied' | 'error' | 'approval_pending';
  timestamp: string;
  durationMs: number;
}
```

### DB migration

New `action_audit` table: sessionId, action, params (JSON), outcome, timestamp, durationMs. Append-only for compliance.

Add `action_policy` JSON column to profiles table (nullable, default null).
Add `output_mode` TEXT column to profiles table (default 'pr').

---

## Phase 2: PII Sanitizer (shared package)

**`packages/shared/src/sanitize/patterns.ts`** — Regex patterns:
- Email: RFC-5322-lite, masks to `j***@d*****.com`
- Phone: international + US/EU, masks to `***-***-1234`
- API keys: `Bearer `, `ghp_`, `ghs_`, `AKIA`, `sk-` prefixes → `[REDACTED]`
- Author fields: for `sanitizeDeep()`, redact known field names (`createdBy`, `author.login`, `user.email`, `assignedTo`)
- IP addresses: IPv4 → `***.***.***.123` (last octet preserved for debugging)

**`packages/shared/src/sanitize/sanitize.ts`** — Core:
```typescript
function sanitize(text: string, config: DataSanitizationConfig): string;
function sanitizeDeep<T>(obj: T, config: DataSanitizationConfig): T;
const SANITIZE_PRESETS: Record<'strict' | 'standard' | 'relaxed', DataSanitizationConfig>;
```

- Pure, synchronous, zero dependencies
- `sanitizeDeep` walks object trees, sanitizes all string values, redacts known field names
- Presets: `strict` (all patterns), `standard` (emails + api keys + author fields), `relaxed` (api keys only)
- Fail-open: if a regex throws, pass through + log warning

**`packages/shared/src/sanitize/sanitize.test.ts`** — Tests covering email masking, false positive resistance, allowedDomains bypass, sanitizeDeep on nested objects, preset behavior.

---

## Phase 3: Action Engine (daemon-side)

New module at `packages/daemon/src/actions/`.

### Framework

**`packages/daemon/src/actions/action-handler.ts`** — Base interface:
```typescript
interface ActionHandler {
  readonly action: string;
  readonly group: ActionGroup;
  execute(params: Record<string, unknown>, ctx: ActionContext): Promise<unknown>;
}

interface ActionContext {
  sessionId: string;
  profileName: string;
  sanitizationConfig: DataSanitizationConfig;
  logger: Logger;
}
```

**`packages/daemon/src/actions/action-engine.ts`** — Orchestrator:
- Receives `ActionRequest` from MCP tool
- Checks if the action's group is in `profile.actionPolicy.enabledGroups`
- Checks `actionOverrides` for resource restrictions / approval requirements
- If approved: executes handler, sanitizes response via `sanitizeDeep()`, logs audit entry
- If requires approval: creates escalation (reuses `PendingRequests` pattern)
- If denied: returns error with reason
- Wraps everything in try/catch with timeout (30s default)

**`packages/daemon/src/actions/action-registry.ts`** — Map of action name → handler. Populated at daemon startup based on available credentials/config.

**`packages/daemon/src/actions/audit-repository.ts`** — SQLite CRUD for `action_audit` table.

### GitHub handlers

**`packages/daemon/src/actions/github/client.ts`** — Shared Octokit client using daemon's `github-pat` from Key Vault.

- `read-issue.ts`, `search-issues.ts`, `read-issue-comments.ts`
- `read-pr.ts`, `read-pr-comments.ts`, `read-pr-diff.ts`
- `read-file.ts`, `search-code.ts`

### Azure DevOps handlers

**`packages/daemon/src/actions/ado/client.ts`** — ADO REST client using PAT or Entra token.

- `read-workitem.ts`, `search-workitems.ts`

### Azure Observability handlers

**`packages/daemon/src/actions/azure-logs/client.ts`** — Azure Monitor client via `@azure/monitor-query`.

- `query-logs.ts`, `read-app-insights.ts`, `read-container-logs.ts`

---

## Phase 4: MCP Tools, MCP Proxy & Agent Awareness

### Action MCP tools

**`packages/escalation-mcp/src/tools/actions.ts`** — Registers one MCP tool per action. Only actions enabled in the profile's `actionPolicy` get registered — agent can't see tools it doesn't have.

**`packages/escalation-mcp/src/session-bridge.ts`** — Add:
```typescript
executeAction(sessionId: string, action: string, params: Record<string, unknown>): Promise<ActionResponse>;
getAvailableActions(sessionId: string): string[];
```

**`packages/escalation-mcp/src/server.ts`** — Dynamic tool registration based on `bridge.getAvailableActions(sessionId)`.

### MCP Proxy

**`packages/daemon/src/api/mcp-proxy-handler.ts`** — New Fastify route at `/mcp-proxy/:serverName/:sessionId`:
- Looks up the real MCP server URL from session's merged MCP servers
- Forwards MCP requests to the actual server, injecting `headers` (auth tokens etc.)
- PII-strips responses via `sanitizeDeep()` using session's sanitization config
- Audit logs all tool calls
- Enforces timeout (30s default)

**`packages/daemon/src/sessions/session-manager.ts`** — At line 219, rewrite injected MCP server URLs:
```typescript
// Before: { name: 'my-service', url: 'https://external-mcp.com/mcp' }
// After:  { name: 'my-service', url: 'http://daemon:3100/mcp-proxy/my-service/{sessionId}' }
const mcpServers = [
  { name: 'escalation', url: mcpUrl },
  ...mergedMcpServers.map(s => ({
    name: s.name,
    url: `${mcpBaseUrl}/mcp-proxy/${encodeURIComponent(s.name)}/${sessionId}`,
    // headers NOT passed to agent — daemon handles auth
  })),
];
```

Agent never sees the real MCP server URL or its auth headers.

### Agent awareness in CLAUDE.md

**`packages/daemon/src/sessions/claude-md-generator.ts`** — New "Operating Environment" section:

```markdown
## Operating Environment

You are running inside an Autopod sandbox container with restricted access.

### Network
- Direct internet access is BLOCKED. Do not attempt curl/fetch/wget to external URLs.
- All external data access goes through the MCP action tools listed below.

### Available Actions
These MCP tools let you access external context. All responses are PII-sanitized.
- read_issue(repo, issue_number) — read a GitHub issue
- search_issues(repo, query) — search GitHub issues
[... only lists actions enabled for this profile ...]

### Additional MCP Servers
[... only if proxied MCP servers are configured ...]
- context-enrichment: Enriches task context with domain knowledge

### What You Cannot Do
- Access APIs directly (no tokens, no credentials)
- Read files from repos other than your worktree (use read_file action instead)
- See real email addresses or usernames (they are masked for privacy)

### Git Operations
- You CAN use git normally within your worktree (commit, branch, etc.)
- Push and PR creation are handled by the system after your work completes.
- Do NOT attempt to push or create PRs yourself.
```

For **research pods** (web access enabled), the section adapts:
```markdown
### Network
- You have LIMITED internet access for research purposes.
- Allowed domains: *.github.com, *.stackoverflow.com, arxiv.org, ...
- Blocked: cloud metadata endpoints, internal services.
- Use action tools for structured data (issues, PRs, logs) when possible.

### Output
- Write your findings to `research-output.md` in the workspace root.
- No build or validation will run — your output IS the deliverable.
```

Generated dynamically from profile config — always accurate.

---

## Phase 5: Event Bus + Notification Sanitization

**`packages/daemon/src/sessions/event-bus.ts`** — Sanitizing decorator wrapper.

**`packages/daemon/src/notifications/notification-service.ts`** — Sanitize Teams notification payloads.

**`packages/daemon/src/sessions/section-resolver.ts`** — Sanitize dynamically fetched CLAUDE.md sections.

---

## Dependency Graph

```
Phase 1 (types/schemas) ─┬─→ Phase 2 (PII sanitizer)
                          └─→ Phase 3 (action engine + handlers)
                                └─→ Phase 4 (MCP tools + proxy + agent awareness)
                                      └─→ Phase 5 (event bus sanitization)
```

Phases 2 and 3 are independent — can be parallelized.

---

## Configuration Examples

### Standard coding pod with context access
```json
{
  "name": "my-frontend-app",
  "repoUrl": "https://github.com/myorg/frontend",
  "actionPolicy": {
    "enabledGroups": ["github-issues", "github-prs", "azure-logs"],
    "actionOverrides": [
      { "action": "read_file", "allowedResources": ["myorg/shared-components"] },
      { "action": "query_logs", "requiresApproval": true }
    ],
    "sanitization": { "preset": "standard", "allowedDomains": ["example.com"] }
  },
  "mcpServers": [{
    "name": "context-enrichment",
    "url": "https://your-enrichment-service.azurewebsites.net/mcp",
    "headers": { "Authorization": "Bearer ${ENRICHMENT_API_KEY}" },
    "description": "Enriches task context with domain knowledge"
  }],
  "outputMode": "pr"
}
```

### Research pod with web access
```json
{
  "name": "research-pod",
  "repoUrl": "https://github.com/myorg/research-outputs",
  "template": "node22",
  "networkPolicy": {
    "enabled": true,
    "allowedHosts": ["*.github.com", "*.stackoverflow.com", "arxiv.org", "*.medium.com"],
    "replaceDefaults": true
  },
  "actionPolicy": {
    "enabledGroups": ["github-issues", "github-code"],
    "sanitization": { "preset": "standard" }
  },
  "outputMode": "artifact",
  "buildCommand": "echo 'no build'",
  "startCommand": "echo 'no server'",
  "customInstructions": "Write your research findings to research-output.md."
}
```

---

## Credentials the Daemon Needs

| Backend | Credential | Source |
|---------|-----------|--------|
| GitHub | PAT or GitHub App (future) | Key Vault `github-pat` (already exists) |
| Azure DevOps | PAT or Entra token | Key Vault (new secret `ado-pat`) |
| Azure Monitor | Managed Identity | Already available on Container Apps infra |
| App Insights | Managed Identity | Already available |
| Context Enrichment | API key | Key Vault or profile MCP server headers |

No new credential infrastructure needed for MVP.

---

## Future Enhancements

- **Token Vending escape hatch** — for cases actions can't cover (niche APIs)
- **GitHub App backend** — replace PAT with scoped 1hr installation tokens
- **Vault integration** — dynamic secrets for databases, cloud providers
- **OPA/Cedar policies** — replace the simple `actionOverrides` with a real policy engine
- **Egress proxy for research pods** — squid/mitmproxy sidecar for full URL audit trail

---

## Verification

1. **Types/schemas**: `npx pnpm build` passes. Profile creation with `actionPolicy` validates.
2. **Sanitizer**: Unit tests for `sanitize()` and `sanitizeDeep()`.
3. **Action engine**: Unit tests for authorization (enabled groups, overrides, denied, approval-required).
4. **GitHub actions**: Integration test — `read_issue` returns sanitized response.
5. **MCP proxy**: Injected MCP server URL is rewritten to proxy. Agent call reaches actual server. Response is PII-stripped.
6. **Agent awareness**: Generated CLAUDE.md contains "Operating Environment" with correct actions/constraints.
7. **Dynamic tool registration**: Only enabled actions appear as MCP tools.
8. **Research pod**: Session with `outputMode: 'artifact'` skips validation, collects output file.
9. **Audit trail**: `action_audit` table has entries for all action executions.

---

## Critical Files Summary

| File | Action |
|------|--------|
| `packages/shared/src/types/actions.ts` | Create — ActionPolicy, ActionRequest/Response, audit types |
| `packages/shared/src/types/profile.ts` | Modify — add `actionPolicy`, `outputMode` |
| `packages/shared/src/schemas/profile.schema.ts` | Modify — add Zod schemas |
| `packages/shared/src/sanitize/sanitize.ts` | Create — core sanitizer |
| `packages/shared/src/sanitize/patterns.ts` | Create — regex patterns |
| `packages/daemon/src/actions/action-engine.ts` | Create — orchestrator |
| `packages/daemon/src/actions/action-handler.ts` | Create — handler interface |
| `packages/daemon/src/actions/action-registry.ts` | Create — handler registry |
| `packages/daemon/src/actions/audit-repository.ts` | Create — audit persistence |
| `packages/daemon/src/actions/github/client.ts` | Create — Octokit wrapper |
| `packages/daemon/src/actions/github/*.ts` | Create — 8 GitHub action handlers |
| `packages/daemon/src/actions/ado/client.ts` | Create — ADO REST client |
| `packages/daemon/src/actions/ado/*.ts` | Create — 2 ADO handlers |
| `packages/daemon/src/actions/azure-logs/client.ts` | Create — Monitor client |
| `packages/daemon/src/actions/azure-logs/*.ts` | Create — 3 log handlers |
| `packages/escalation-mcp/src/tools/actions.ts` | Create — MCP tool registrations |
| `packages/escalation-mcp/src/session-bridge.ts` | Modify — add executeAction, getAvailableActions |
| `packages/escalation-mcp/src/server.ts` | Modify — dynamic tool registration |
| `packages/daemon/src/api/mcp-proxy-handler.ts` | Create — MCP proxy for injected servers |
| `packages/daemon/src/sessions/session-manager.ts` | Modify — rewrite MCP URLs to proxy, artifact output mode |
| `packages/daemon/src/sessions/claude-md-generator.ts` | Modify — Operating Environment section |
| `packages/daemon/src/sessions/event-bus.ts` | Modify — sanitizing decorator |
