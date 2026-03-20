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
                 | 'ado-workitems' | 'azure-logs';

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
```

**`packages/shared/src/schemas/profile.schema.ts`** — Zod schemas for `actionPolicySchema`, `actionGroupSchema`, `actionOverrideSchema`, `dataSanitizationSchema`. Added to `createProfileSchema` with `.nullable().default(null)`.

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

**`packages/shared/src/sanitize/sanitize.test.ts`** — Tests:
- Email masking (various formats, unicode)
- False positive resistance (emails in code, version numbers vs IPs)
- `allowedDomains` bypass
- `sanitizeDeep` on nested objects with author fields
- Preset behavior differences

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

**`packages/daemon/src/actions/github/client.ts`** — Shared GitHub API client:
- Uses Octokit with the daemon's `github-pat` from Key Vault (or GitHub App token in future)
- Single client instance, reused across handlers
- Rate limit awareness (respect `x-ratelimit-remaining`)

**`packages/daemon/src/actions/github/read-issue.ts`** — Fetches issue, maps to clean response object, returns for sanitization.

**`packages/daemon/src/actions/github/search-issues.ts`** — Uses GitHub search API, returns summaries.

**`packages/daemon/src/actions/github/read-issue-comments.ts`** — Paginated comment fetch, truncated to `max_results`.

**`packages/daemon/src/actions/github/read-pr.ts`** — PR metadata + files changed list.

**`packages/daemon/src/actions/github/read-pr-comments.ts`** — Review comments + inline comments.

**`packages/daemon/src/actions/github/read-pr-diff.ts`** — Raw diff, optionally filtered to specific file.

**`packages/daemon/src/actions/github/read-file.ts`** — File contents from a repo (via Contents API), with ref support for branches/tags.

**`packages/daemon/src/actions/github/search-code.ts`** — Code search API, returns matching snippets with context.

### Azure DevOps handlers

**`packages/daemon/src/actions/ado/client.ts`** — ADO REST client using PAT or Entra ID token.

**`packages/daemon/src/actions/ado/read-workitem.ts`** — Work item fetch via `GET /{org}/{project}/_apis/wit/workitems/{id}`.

**`packages/daemon/src/actions/ado/search-workitems.ts`** — WIQL query execution.

### Azure Observability handlers

**`packages/daemon/src/actions/azure-logs/client.ts`** — Azure Monitor client using `@azure/monitor-query` SDK. Authenticates via Managed Identity or Workload Identity.

**`packages/daemon/src/actions/azure-logs/query-logs.ts`** — Log Analytics KQL query execution.

**`packages/daemon/src/actions/azure-logs/read-app-insights.ts`** — Application Insights query.

**`packages/daemon/src/actions/azure-logs/read-container-logs.ts`** — Container Apps log stream fetch.

---

## Phase 4: MCP Tools + Agent Awareness

### MCP tool registration

**`packages/escalation-mcp/src/tools/actions.ts`** — New file. Registers one MCP tool per action:

```typescript
// Example: read_issue
server.tool('read_issue',
  'Read a GitHub issue. Returns sanitized content (PII stripped). Use this to understand task context.',
  {
    repo: z.string().describe('Repository in owner/name format'),
    issue_number: z.number().int().describe('Issue number'),
  },
  async (input) => {
    const result = await bridge.executeAction(sessionId, 'read_issue', input);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);
```

Each action gets its own tool with descriptive name, description, and typed params. This gives the agent clear affordances — it sees exactly what operations are available.

**`packages/escalation-mcp/src/session-bridge.ts`** — Add:
```typescript
executeAction(sessionId: string, action: string, params: Record<string, unknown>): Promise<ActionResponse>;
getAvailableActions(sessionId: string): string[];
```

**`packages/escalation-mcp/src/server.ts`** — Dynamically register action tools based on `bridge.getAvailableActions(sessionId)`. Only actions enabled in the profile's `actionPolicy` get registered as MCP tools — the agent literally cannot see tools it doesn't have permission for.

### Agent awareness in CLAUDE.md

**`packages/daemon/src/sessions/claude-md-generator.ts`** — Add new "Operating Environment" section generated from profile config:

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
- read_pr(repo, pr_number) — read a GitHub pull request
- read_workitem(org, project, workitem_id) — read an Azure DevOps work item
- query_logs(workspace_id, query) — query Azure Log Analytics
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

New helper function:
```typescript
function generateOperatingEnvironment(
  profile: Profile,
  availableActions: string[]
): string
```

This section is **generated from the profile's `actionPolicy`**, so it's always accurate. If a profile has `enabledGroups: ['github-issues']`, only those actions appear.

---

## Phase 5: Event Bus + Notification Sanitization

Apply PII stripping to outbound data (events, notifications) — not just action responses.

**`packages/daemon/src/sessions/event-bus.ts`** — Wrap with sanitizing decorator:
- `createSanitizingEventBus(innerBus, configLookup)` — composition pattern
- Looks up session's profile sanitization config
- Applies `sanitizeDeep()` to event payloads before broadcasting
- Short-circuits (zero cost) when profile has no `actionPolicy`

**`packages/daemon/src/notifications/notification-service.ts`** — Sanitize Teams notification payloads before card building.

**`packages/daemon/src/sessions/section-resolver.ts`** — Sanitize dynamically fetched CLAUDE.md sections.

---

## Dependency Graph

```
Phase 1 (types/schemas) ─┬─→ Phase 2 (PII sanitizer)
                          └─→ Phase 3 (action engine + handlers)
                                └─→ Phase 4 (MCP tools + agent awareness)
                                      └─→ Phase 5 (event bus sanitization)
```

Phases 2 and 3 are independent — can be parallelized.

---

## Configuration Example

```json
{
  "name": "my-frontend-app",
  "repoUrl": "https://github.com/myorg/frontend",
  "actionPolicy": {
    "enabledGroups": ["github-issues", "github-prs", "azure-logs"],
    "actionOverrides": [
      {
        "action": "read_file",
        "allowedResources": ["myorg/shared-components", "myorg/design-system"]
      },
      {
        "action": "query_logs",
        "requiresApproval": true
      }
    ],
    "sanitization": {
      "preset": "standard",
      "allowedDomains": ["example.com"]
    }
  }
}
```

---

## Credentials the Daemon Needs

The daemon (not the pod) holds credentials for the action backends:

| Backend | Credential | Source |
|---------|-----------|--------|
| GitHub | PAT or GitHub App (future) | Key Vault `github-pat` (already exists) |
| Azure DevOps | PAT or Entra token | Key Vault (new secret `ado-pat`) |
| Azure Monitor | Managed Identity | Already available on Container Apps infra |
| App Insights | Managed Identity | Already available |

No new credential infrastructure needed for MVP — the daemon already authenticates to Key Vault via Managed Identity.

---

## Future: Token Vending as Escape Hatch

If we hit a case where actions can't cover the need (e.g., agent needs to interact with a niche API we haven't built a handler for), we can add a `request_token` tool as a controlled fallback. But actions-first is the default posture.

---

## Verification

1. **Types/schemas**: `npx pnpm build` passes. Profile creation with `actionPolicy` validates.
2. **Sanitizer**: Unit tests for `sanitize()` and `sanitizeDeep()` — email masking, author field redaction, allowedDomains bypass, preset differences.
3. **Action engine**: Unit tests for authorization (enabled groups, overrides, denied actions, approval-required).
4. **GitHub actions**: Integration test — create session with `github-issues` enabled, call `read_issue`, verify response is sanitized (author emails masked).
5. **Agent awareness**: Inspect generated CLAUDE.md — verify "Operating Environment" section lists only enabled actions.
6. **Dynamic tool registration**: Session with `enabledGroups: ['github-issues']` should only see `read_issue`, `search_issues`, `read_issue_comments` as MCP tools — not PR or code tools.
7. **Audit trail**: After action execution, verify `action_audit` table has entry with correct params and outcome.
8. **Approval flow**: Profile with `actionOverrides: [{ action: 'query_logs', requiresApproval: true }]`. Agent calls `query_logs`, verify it creates an escalation.

---

## Critical Files Summary

| File | Action |
|------|--------|
| `packages/shared/src/types/actions.ts` | Create — ActionPolicy, ActionRequest/Response, audit types |
| `packages/shared/src/types/profile.ts` | Modify — add `actionPolicy` field |
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
| `packages/daemon/src/sessions/claude-md-generator.ts` | Modify — Operating Environment section |
| `packages/daemon/src/sessions/event-bus.ts` | Modify — sanitizing decorator |
