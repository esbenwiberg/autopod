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

## Core Architecture: Unified Action Definitions

**Every action — built-in and custom — is defined as JSON config with the same schema.** The only difference is the `handler` field, which routes to either a specialized executor (for complex integrations) or the generic HTTP executor (for custom/simple actions).

```
Action Definition (always JSON config — same schema)
        │
        ├── handler: "github"     → Specialized (Octokit, pagination, rate limits)
        ├── handler: "ado"        → Specialized (ADO REST client, WIQL queries)
        ├── handler: "azure-logs" → Specialized (Monitor SDK, tabular responses, managed identity)
        └── handler: "http"       → Generic HTTP executor (zero-code custom actions)
```

### Why specialized handlers for GitHub/ADO/Azure

These aren't simple "hit endpoint A" operations:
- **GitHub (Octokit):** Pagination via `Link` headers, rate limit backoff (`x-ratelimit-remaining`), GraphQL for some queries, raw text responses for diffs
- **Azure DevOps:** WIQL query language for work item search, `Basic` auth with base64 PAT, continuation tokens for pagination
- **Azure Monitor:** OAuth via `@azure/identity` + Managed Identity, tabular response format (columns + rows, not objects), KQL query validation

### Why a generic HTTP handler for everything else

90% of custom integrations are "call this REST endpoint, pick these fields." No SDK needed, no special auth dance. Config-only, zero code:

```json
{
  "name": "enrich_context",
  "description": "Search the knowledge base for relevant context",
  "handler": "http",
  "endpoint": {
    "url": "https://my-service.com/api/enrich",
    "method": "POST",
    "auth": { "type": "bearer", "secret": "${ENRICHMENT_API_KEY}" }
  },
  "params": {
    "query": { "type": "string", "required": true, "description": "What to search for" },
    "source": { "type": "string", "required": false, "description": "Knowledge source" },
    "max_results": { "type": "number", "required": false, "default": 5 }
  },
  "request": {
    "bodyMapping": { "search_query": "{{query}}", "source_filter": "{{source}}", "limit": "{{max_results}}" }
  },
  "response": {
    "resultPath": "data.results",
    "fields": ["title", "content", "relevance_score"],
    "redactFields": ["author", "created_by_email"]
  }
}
```

### Unified action config schema

```typescript
interface ActionDefinition {
  name: string;                          // MCP tool name
  description: string;                   // Shown to agent
  group: ActionGroup;                    // For enable/disable grouping
  handler: 'github' | 'ado' | 'azure-logs' | 'http';  // Which executor

  // === Params (what the agent passes) ===
  params: Record<string, ParamDef>;

  // === HTTP-specific (handler: 'http') ===
  endpoint?: {
    url: string;                         // Supports {{param}} templates
    method: 'GET' | 'POST' | 'PUT';
    auth?: AuthConfig;
    timeout?: number;                    // ms, default 15000
  };
  request?: {
    bodyMapping?: Record<string, string>;   // POST body template
    queryMapping?: Record<string, string>;  // GET query params template
    pathMapping?: Record<string, string>;   // URL path segments
  };

  // === Response (shared by all handlers) ===
  response: {
    resultPath?: string;                 // JSONPath to results (e.g. 'data.items')
    fields: string[];                    // Whitelist — ONLY these fields returned
    redactFields?: string[];             // Additional fields to PII-mask
  };
}

interface ParamDef {
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];                       // Restrict to specific values
}

type AuthConfig =
  | { type: 'bearer'; secret: string }          // ${ENV_VAR} references
  | { type: 'basic'; username: string; password: string }
  | { type: 'custom-header'; name: string; value: string }
  | { type: 'none' };
```

### Built-in actions ship as default configs

`packages/daemon/src/actions/defaults/github-issues.json`:
```json
[
  {
    "name": "read_issue",
    "description": "Read a GitHub issue. Returns sanitized content.",
    "group": "github-issues",
    "handler": "github",
    "params": {
      "repo": { "type": "string", "required": true, "description": "Repository (owner/name)" },
      "issue_number": { "type": "number", "required": true, "description": "Issue number" }
    },
    "response": {
      "fields": ["title", "body", "state", "labels", "comments", "created_at", "updated_at"],
      "redactFields": ["user.login", "user.email", "assignee.login"]
    }
  },
  {
    "name": "search_issues",
    "description": "Search GitHub issues by query.",
    "group": "github-issues",
    "handler": "github",
    "params": {
      "repo": { "type": "string", "required": true, "description": "Repository (owner/name)" },
      "query": { "type": "string", "required": true, "description": "Search query" },
      "state": { "type": "string", "required": false, "enum": ["open", "closed", "all"], "default": "open" },
      "max_results": { "type": "number", "required": false, "default": 10 }
    },
    "response": {
      "fields": ["number", "title", "state", "labels", "created_at"],
      "redactFields": ["user.login"]
    }
  }
]
```

Profile custom actions use the **exact same schema** — just with `"handler": "http"`. Users can also override built-in actions by defining one with the same `name` (profile overrides defaults).

---

## Action Catalog (MVP)

### Built-in: GitHub (handler: "github")
| Action | Group | Params |
|--------|-------|--------|
| `read_issue` | github-issues | repo, issue_number |
| `search_issues` | github-issues | repo, query, state?, max_results? |
| `read_issue_comments` | github-issues | repo, issue_number, max_results? |
| `read_pr` | github-prs | repo, pr_number |
| `read_pr_comments` | github-prs | repo, pr_number, max_results? |
| `read_pr_diff` | github-prs | repo, pr_number, file_path? |
| `read_file` | github-code | repo, path, ref? |
| `search_code` | github-code | repo, query, max_results? |

### Built-in: Azure DevOps (handler: "ado")
| Action | Group | Params |
|--------|-------|--------|
| `read_workitem` | ado-workitems | org, project, workitem_id |
| `search_workitems` | ado-workitems | org, project, query, state?, type?, max_results? |

### Built-in: Azure Logs (handler: "azure-logs")
| Action | Group | Params |
|--------|-------|--------|
| `query_logs` | azure-logs | workspace_id, query (KQL), timespan? |
| `read_app_insights` | azure-logs | app_id, query (KQL), timespan? |
| `read_container_logs` | azure-logs | resource_group, container_app, timespan?, filter? |

### Custom: User-defined (handler: "http")
Defined in `profile.actionPolicy.customActions[]`. Unlimited. Examples: context enrichment, feature flags, internal APIs, Slack channels, etc.

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
1. At session provisioning, the daemon rewrites `InjectedMcpServer.url` to point to the daemon's proxy endpoint
2. Agent calls the proxy URL — the daemon forwards to the real server
3. Daemon injects `InjectedMcpServer.headers` (auth tokens etc.) into the forwarded request
4. Response is PII-stripped before returning to agent
5. All calls are audit-logged

Agent never sees the real MCP server URL or its auth headers.

**Implementation:**
- **`packages/daemon/src/api/mcp-proxy-handler.ts`** — Fastify route at `/mcp-proxy/:serverName/:sessionId`
- **`packages/daemon/src/sessions/session-manager.ts`** — Rewrite injected MCP server URLs to proxy URLs at line 219

---

## Research Pods: Web-Crawling Mode

Some pods need to crawl the web — fundamentally different from coding pods. Solved as a profile-level concern:

### Profile config
```json
{
  "name": "research-pod",
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

### New profile fields
- `outputMode: 'pr' | 'artifact'` — `artifact` skips validation, collects output file instead of git diff/PR
- Research pods get a generous domain allowlist but still firewalled (block cloud metadata `169.254.169.254`, internal services)
- PII stripping on output artifact before storage/sharing
- Agent awareness section in CLAUDE.md adapts to show allowed domains and output instructions

---

## PII Sanitizer

**`packages/shared/src/sanitize/`** — Pure, synchronous, zero dependencies:

- `sanitize(text, config)` — regex-based pattern matching
- `sanitizeDeep(obj, config)` — walks object trees, sanitizes strings, redacts known field names
- Presets: `strict` (all patterns), `standard` (emails + api keys + author fields), `relaxed` (api keys only)
- Patterns: email masking, phone masking, API key redaction, author field redaction, IP masking
- Fail-open: if regex throws, pass through + log warning
- `allowedDomains` bypass for test fixtures
- `response.redactFields` per action definition for targeted field removal

### Integration points
1. **Action engine** — `sanitizeDeep()` on every action response (primary)
2. **MCP proxy** — sanitize proxied MCP responses
3. **Event bus** — sanitizing decorator on WebSocket broadcasts
4. **Notifications** — sanitize Teams card payloads
5. **Section resolver** — sanitize dynamically fetched CLAUDE.md sections

---

## Agent Awareness (CLAUDE.md)

**`packages/daemon/src/sessions/claude-md-generator.ts`** — Dynamic "Operating Environment" section generated from profile config:

### Standard coding pod
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
- enrich_context(query, source?) — search the knowledge base
[... only lists actions enabled for this profile ...]

### What You Cannot Do
- Access APIs directly (no tokens, no credentials)
- Read files from repos other than your worktree (use read_file action instead)
- See real email addresses or usernames (they are masked for privacy)

### Git Operations
- You CAN use git normally within your worktree (commit, branch, etc.)
- Push and PR creation are handled by the system after your work completes.
- Do NOT attempt to push or create PRs yourself.
```

### Research pod (adapts automatically)
```markdown
### Network
- You have LIMITED internet access for research purposes.
- Allowed domains: *.github.com, *.stackoverflow.com, arxiv.org, ...
- Blocked: cloud metadata endpoints, internal services.

### Output
- Write your findings to `research-output.md` in the workspace root.
- No build or validation will run — your output IS the deliverable.
```

---

## Implementation Phases

### Phase 1: Types, Schemas & Action Definition Framework
**Files to create/modify:**
- `packages/shared/src/types/actions.ts` — ActionDefinition, ActionPolicy, ParamDef, AuthConfig, ActionRequest/Response, ActionAuditEntry
- `packages/shared/src/types/profile.ts` — Add `actionPolicy`, `outputMode`
- `packages/shared/src/schemas/profile.schema.ts` — Zod schemas for action policy + custom actions
- `packages/shared/src/schemas/action-definition.schema.ts` — Zod schema for ActionDefinition (validates both built-in and custom)
- DB migration — `action_audit` table, `action_policy` + `output_mode` columns on profiles

### Phase 2: PII Sanitizer
**Files to create:**
- `packages/shared/src/sanitize/patterns.ts` — Regex patterns
- `packages/shared/src/sanitize/sanitize.ts` — `sanitize()`, `sanitizeDeep()`, presets
- `packages/shared/src/sanitize/sanitize.test.ts` — Tests

### Phase 3: Action Engine + Specialized Handlers
**Files to create:**
- `packages/daemon/src/actions/action-engine.ts` — Orchestrator (authorization, dispatch, sanitize, audit)
- `packages/daemon/src/actions/action-registry.ts` — Loads default configs + profile custom actions
- `packages/daemon/src/actions/generic-http-handler.ts` — Generic HTTP executor (template substitution, auth, field extraction)
- `packages/daemon/src/actions/handlers/github-handler.ts` — Octokit-based (pagination, rate limits)
- `packages/daemon/src/actions/handlers/ado-handler.ts` — ADO REST client (WIQL, Basic auth)
- `packages/daemon/src/actions/handlers/azure-logs-handler.ts` — Monitor SDK (managed identity, tabular)
- `packages/daemon/src/actions/defaults/*.json` — Built-in action definition configs
- `packages/daemon/src/actions/audit-repository.ts` — SQLite audit log

### Phase 4: MCP Tools + MCP Proxy + Agent Awareness
**Files to create/modify:**
- `packages/escalation-mcp/src/tools/actions.ts` — Dynamic MCP tool registration from action definitions
- `packages/escalation-mcp/src/session-bridge.ts` — Add `executeAction`, `getAvailableActions`
- `packages/escalation-mcp/src/server.ts` — Dynamic tool registration
- `packages/daemon/src/api/mcp-proxy-handler.ts` — MCP proxy for injected servers
- `packages/daemon/src/sessions/session-manager.ts` — Rewrite MCP URLs + artifact output mode
- `packages/daemon/src/sessions/claude-md-generator.ts` — Operating Environment section

### Phase 5: Event Bus + Notification Sanitization
**Files to modify:**
- `packages/daemon/src/sessions/event-bus.ts` — Sanitizing decorator
- `packages/daemon/src/notifications/notification-service.ts` — Sanitize payloads
- `packages/daemon/src/sessions/section-resolver.ts` — Sanitize fetched sections

### Dependency Graph
```
Phase 1 (types/schemas) ─┬─→ Phase 2 (PII sanitizer)
                          └─→ Phase 3 (action engine + handlers)
                                └─→ Phase 4 (MCP tools + proxy + awareness)
                                      └─→ Phase 5 (event bus sanitization)
```

---

## Configuration Examples

### Standard coding pod with custom actions
```json
{
  "name": "my-frontend-app",
  "repoUrl": "https://github.com/myorg/frontend",
  "actionPolicy": {
    "enabledGroups": ["github-issues", "github-prs", "azure-logs", "custom"],
    "customActions": [
      {
        "name": "enrich_context",
        "description": "Search the knowledge base for relevant context",
        "group": "custom",
        "handler": "http",
        "endpoint": {
          "url": "https://my-enrichment.azurewebsites.net/api/enrich",
          "method": "POST",
          "auth": { "type": "bearer", "secret": "${ENRICHMENT_API_KEY}" }
        },
        "params": {
          "query": { "type": "string", "required": true, "description": "What to search for" },
          "max_results": { "type": "number", "required": false, "default": 5 }
        },
        "request": { "bodyMapping": { "search_query": "{{query}}", "limit": "{{max_results}}" } },
        "response": {
          "resultPath": "data.results",
          "fields": ["title", "content", "relevance_score"],
          "redactFields": ["author_email"]
        }
      },
      {
        "name": "get_feature_flags",
        "description": "Check feature flags for an environment",
        "group": "custom",
        "handler": "http",
        "endpoint": {
          "url": "https://launchdarkly.mycompany.com/api/flags",
          "method": "GET",
          "auth": { "type": "bearer", "secret": "${LD_API_KEY}" }
        },
        "params": {
          "environment": { "type": "string", "required": true, "enum": ["dev", "staging", "production"] }
        },
        "request": { "queryMapping": { "env": "{{environment}}" } },
        "response": { "fields": ["key", "name", "on", "variations"] }
      }
    ],
    "actionOverrides": [
      { "action": "read_file", "allowedResources": ["myorg/shared-components"] },
      { "action": "query_logs", "requiresApproval": true }
    ],
    "sanitization": { "preset": "standard", "allowedDomains": ["example.com"] }
  },
  "outputMode": "pr"
}
```

### Research pod
```json
{
  "name": "research-pod",
  "repoUrl": "https://github.com/myorg/research-outputs",
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
  "startCommand": "echo 'no server'"
}
```

---

## Credentials the Daemon Needs

| Backend | Credential | Source |
|---------|-----------|--------|
| GitHub | PAT or GitHub App (future) | Key Vault `github-pat` (already exists) |
| Azure DevOps | PAT or Entra token | Key Vault (new secret `ado-pat`) |
| Azure Monitor | Managed Identity | Already available on Container Apps infra |
| Custom actions | `${SECRET_REF}` in auth config | Daemon env vars or Key Vault |

---

## Future Enhancements

- **Token Vending escape hatch** — for cases where actions can't cover the need
- **GitHub App backend** — replace PAT with scoped 1hr installation tokens
- **Vault integration** — dynamic secrets for databases, cloud providers
- **OPA/Cedar policies** — replace simple `actionOverrides` with a real policy engine
- **Egress proxy for research pods** — squid/mitmproxy sidecar for full URL audit trail
- **Custom handler plugins** — if the generic HTTP executor isn't enough, write a handler plugin

---

## Verification

1. **Types/schemas**: `npx pnpm build` passes. Profile creation with `actionPolicy` + `customActions` validates.
2. **Sanitizer**: Unit tests for `sanitize()` and `sanitizeDeep()`.
3. **Action engine**: Unit tests for authorization (enabled groups, overrides, denied, approval-required).
4. **Built-in actions**: `read_issue` returns sanitized response via GitHub handler.
5. **Custom actions**: Define a custom `http` action in profile config, call it via MCP, verify HTTP request made + response sanitized.
6. **MCP proxy**: Injected MCP server URL rewritten to proxy. Agent call reaches actual server. Response PII-stripped.
7. **Agent awareness**: CLAUDE.md contains "Operating Environment" with correct actions listed (both built-in and custom).
8. **Dynamic tool registration**: Only enabled actions (built-in + custom) appear as MCP tools.
9. **Research pod**: Session with `outputMode: 'artifact'` skips validation, collects output file.
10. **Audit trail**: `action_audit` table has entries for all action executions.

---

## Critical Files Summary

| File | Action |
|------|--------|
| `packages/shared/src/types/actions.ts` | Create — ActionDefinition, ActionPolicy, ParamDef, AuthConfig, audit types |
| `packages/shared/src/schemas/action-definition.schema.ts` | Create — Zod schema for action definitions |
| `packages/shared/src/types/profile.ts` | Modify — add `actionPolicy`, `outputMode` |
| `packages/shared/src/schemas/profile.schema.ts` | Modify — add action policy schemas |
| `packages/shared/src/sanitize/sanitize.ts` | Create — core sanitizer |
| `packages/shared/src/sanitize/patterns.ts` | Create — regex patterns |
| `packages/daemon/src/actions/action-engine.ts` | Create — orchestrator |
| `packages/daemon/src/actions/action-registry.ts` | Create — loads defaults + profile custom actions |
| `packages/daemon/src/actions/generic-http-handler.ts` | Create — generic HTTP executor |
| `packages/daemon/src/actions/handlers/github-handler.ts` | Create — Octokit-based handler |
| `packages/daemon/src/actions/handlers/ado-handler.ts` | Create — ADO REST handler |
| `packages/daemon/src/actions/handlers/azure-logs-handler.ts` | Create — Monitor SDK handler |
| `packages/daemon/src/actions/defaults/*.json` | Create — 13 built-in action configs |
| `packages/daemon/src/actions/audit-repository.ts` | Create — audit persistence |
| `packages/escalation-mcp/src/tools/actions.ts` | Create — dynamic MCP tool registration |
| `packages/escalation-mcp/src/session-bridge.ts` | Modify — add executeAction, getAvailableActions |
| `packages/escalation-mcp/src/server.ts` | Modify — dynamic tool registration |
| `packages/daemon/src/api/mcp-proxy-handler.ts` | Create — MCP proxy for injected servers |
| `packages/daemon/src/sessions/session-manager.ts` | Modify — MCP URL rewrite + artifact mode |
| `packages/daemon/src/sessions/claude-md-generator.ts` | Modify — Operating Environment section |
| `packages/daemon/src/sessions/event-bus.ts` | Modify — sanitizing decorator |
