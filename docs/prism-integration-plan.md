# Session Injection System — MCP Servers & CLAUDE.md Sections

> **Goal**: Give autopod a generic, opt-in mechanism for injecting MCP servers and CLAUDE.md content into sessions — at both daemon and profile level. This enables Prism integration (and anything else) without coupling autopod to any specific external tool.

## Background

### The Problem

Today, autopod agents start cold. They get a CLAUDE.md with:
- Task description
- Build/start commands
- MCP escalation URL (hardcoded)
- Validation pages
- Custom instructions (if any)

Zero knowledge of the codebase architecture, module boundaries, dependency graphs, or recent changes. The agent figures it all out by reading code — wasting tokens and time, often leading to wrong turns and validation failures.

### The Motivation: Prism's Context Enricher

[Prism](https://github.com/esbenwiberg/prism) is a codebase indexing platform with a new **context enricher** feature (merged 2026-03-17). It provides 6 MCP tools for AI agent context retrieval — architecture overviews, file context, related files, change history, drift detection — all token-budget-aware with intent-based ranking.

But we don't want to hard-code Prism into autopod. Prism is just one possible tool an agent might benefit from. The right move is **generic injection points** that Prism (or anything else) can plug into via configuration.

---

## Design: Two Generic Injection Mechanisms

### 1. MCP Server Injection → into the session runtime
### 2. CLAUDE.md Section Injection → into the generated CLAUDE.md

Both work at **two tiers** with merge semantics:

```
Daemon config (defaults for all sessions)
    ↓ merge
Profile config (repo-specific overrides/additions)
    ↓ result
Session receives the merged set
```

---

## Detailed Design

### New Types

**`packages/shared/src/types/injection.ts`** — new file:

```typescript
/**
 * An MCP server to inject into agent sessions.
 * Configured at daemon level (applies to all sessions) or profile level (repo-specific).
 */
export interface InjectedMcpServer {
  /** Unique name — used as key for merge/override between daemon and profile */
  name: string;
  /** MCP server URL (Streamable HTTP transport) */
  url: string;
  /** Optional auth/custom headers */
  headers?: Record<string, string>;
  /** Human-readable description of what this server provides (injected into CLAUDE.md) */
  description?: string;
  /** Tool usage hints for the agent (injected into CLAUDE.md guidelines) */
  toolHints?: string[];
}

/**
 * A content section to inject into the generated CLAUDE.md.
 * Content is either inline (static) or fetched from a URL at provisioning time (dynamic).
 */
export interface InjectedClaudeMdSection {
  /** Section heading in CLAUDE.md — also used as key for merge/override */
  heading: string;
  /** Priority: lower number = higher in the document (default: 50) */
  priority?: number;
  /** Static content — injected as-is */
  content?: string;
  /**
   * Dynamic content — fetched via POST at provisioning time.
   * If both `content` and `fetch` are set, fetched content is appended after static content.
   * If fetch fails, static content (if any) is used; otherwise section is silently skipped.
   */
  fetch?: {
    /** URL to POST to */
    url: string;
    /** Optional auth header value (e.g., "Bearer prism_xxx") */
    authorization?: string;
    /** POST body — sent as JSON */
    body?: Record<string, unknown>;
    /** Response timeout in ms (default: 10000) */
    timeoutMs?: number;
  };
  /** Max tokens for this section. Dynamic responses are truncated to fit. (default: 4000) */
  maxTokens?: number;
}
```

### Daemon Config Changes

**`packages/shared/src/schemas/config.schema.ts`**:

```typescript
const injectedMcpServerSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  description: z.string().max(500).optional(),
  toolHints: z.array(z.string().max(200)).max(20).optional(),
});

const injectedClaudeMdSectionSchema = z.object({
  heading: z.string().min(1).max(100),
  priority: z.number().int().min(0).max(100).default(50),
  content: z.string().max(50_000).optional(),
  fetch: z.object({
    url: z.string().url(),
    authorization: z.string().optional(),
    body: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
  }).optional(),
  maxTokens: z.number().int().min(100).max(32_000).default(4000),
});

export const daemonConfigSchema = z.object({
  // ... existing fields ...

  /** MCP servers injected into every session (unless overridden by profile) */
  mcpServers: z.array(injectedMcpServerSchema).default([]),
  /** CLAUDE.md sections injected into every session (unless overridden by profile) */
  claudeMdSections: z.array(injectedClaudeMdSectionSchema).default([]),
});
```

### Profile Schema Changes

**`packages/shared/src/types/profile.ts`**:

```typescript
export interface Profile {
  // ... existing fields ...

  /** Additional MCP servers for sessions using this profile */
  mcpServers: InjectedMcpServer[];
  /** Additional CLAUDE.md sections for sessions using this profile */
  claudeMdSections: InjectedClaudeMdSection[];
}
```

**`packages/shared/src/schemas/profile.schema.ts`**:

```typescript
export const createProfileSchema = z.object({
  // ... existing fields ...

  mcpServers: z.array(injectedMcpServerSchema).default([]),
  claudeMdSections: z.array(injectedClaudeMdSectionSchema).default([]),
});
```

### Merge Logic

**`packages/daemon/src/sessions/injection-merger.ts`** — new file:

```typescript
import type { InjectedMcpServer, InjectedClaudeMdSection } from '@autopod/shared';

/**
 * Merge daemon-level and profile-level injections.
 * Profile entries override daemon entries with the same key (name/heading).
 * Otherwise entries are combined.
 */
export function mergeMcpServers(
  daemon: InjectedMcpServer[],
  profile: InjectedMcpServer[],
): InjectedMcpServer[] {
  const merged = new Map<string, InjectedMcpServer>();
  for (const s of daemon) merged.set(s.name, s);
  for (const s of profile) merged.set(s.name, s);  // profile wins
  return [...merged.values()];
}

export function mergeClaudeMdSections(
  daemon: InjectedClaudeMdSection[],
  profile: InjectedClaudeMdSection[],
): InjectedClaudeMdSection[] {
  const merged = new Map<string, InjectedClaudeMdSection>();
  for (const s of daemon) merged.set(s.heading, s);
  for (const s of profile) merged.set(s.heading, s);  // profile wins
  return [...merged.values()].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
}
```

### Section Resolver (Dynamic Fetch)

**`packages/daemon/src/sessions/section-resolver.ts`** — new file:

Responsible for resolving `InjectedClaudeMdSection[]` into actual markdown content at provisioning time.

```typescript
import type { Logger } from 'pino';
import type { InjectedClaudeMdSection } from '@autopod/shared';

export interface ResolvedSection {
  heading: string;
  content: string;
  priority: number;
}

/**
 * Resolve CLAUDE.md sections — fetches dynamic content where configured.
 * Never throws. Failed fetches are logged and silently skipped (or fall back to static content).
 */
export async function resolveSections(
  sections: InjectedClaudeMdSection[],
  logger: Logger,
): Promise<ResolvedSection[]> {
  const results = await Promise.allSettled(
    sections.map(s => resolveOne(s, logger)),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<ResolvedSection | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((s): s is ResolvedSection => s !== null);
}

async function resolveOne(
  section: InjectedClaudeMdSection,
  logger: Logger,
): Promise<ResolvedSection | null> {
  const parts: string[] = [];

  // Static content
  if (section.content) {
    parts.push(section.content);
  }

  // Dynamic fetch
  if (section.fetch) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        section.fetch.timeoutMs ?? 10_000,
      );

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (section.fetch.authorization) {
        headers['Authorization'] = section.fetch.authorization;
      }

      const res = await fetch(section.fetch.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(section.fetch.body ?? {}),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn(
          { heading: section.heading, status: res.status },
          'CLAUDE.md section fetch failed',
        );
      } else {
        const text = await res.text();
        const truncated = truncateToTokenBudget(text, section.maxTokens ?? 4000);
        parts.push(truncated);
      }
    } catch (err) {
      logger.warn(
        { err, heading: section.heading },
        'CLAUDE.md section fetch error — skipping',
      );
    }
  }

  if (parts.length === 0) return null;

  return {
    heading: section.heading,
    content: parts.join('\n\n'),
    priority: section.priority ?? 50,
  };
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  // ~4 chars per token heuristic (same as Prism's truncator)
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n(truncated)';
}
```

### CLAUDE.md Generator Changes

**`packages/daemon/src/sessions/claude-md-generator.ts`**:

The generator receives resolved sections and merged MCP servers as input — it doesn't know where they came from.

```typescript
import type { Profile, Session, InjectedMcpServer } from '@autopod/shared';
import type { ResolvedSection } from './section-resolver.js';

export interface ClaudeMdOptions {
  /** Resolved (already fetched) content sections to inject */
  injectedSections?: ResolvedSection[];
  /** MCP servers beyond the built-in escalation server */
  injectedMcpServers?: InjectedMcpServer[];
}

export function generateClaudeMd(
  profile: Profile,
  session: Session,
  mcpServerUrl: string,
  options?: ClaudeMdOptions,
): string {
```

Injected sections are rendered sorted by priority, after the task header and before Build & Run:

```markdown
## {section.heading}

{section.content}
```

Injected MCP servers are listed alongside the escalation server in the MCP section, with their `description` and `toolHints`:

```markdown
## MCP Servers

### Escalation (ask for help)
- URL: {mcpUrl}
- Tools: ask_human, ask_ai, report_blocker

### {server.name}
{server.description}
- URL: {server.url}
{for each hint in server.toolHints:}
- {hint}
```

### McpServerConfig Extension

**`packages/shared/src/types/runtime.ts`**:

```typescript
export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;  // <-- new
}
```

The `InjectedMcpServer` maps trivially to `McpServerConfig` for the runtime spawn call.

### SessionManager Changes

**`packages/daemon/src/sessions/session-manager.ts`**:

In `processSession()`, between worktree creation and CLAUDE.md generation:

```typescript
// Merge daemon + profile injections
const mergedMcpServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
const mergedSections = mergeClaudeMdSections(daemonConfig.claudeMdSections, profile.claudeMdSections);

// Resolve dynamic sections (fetches URLs, respects token budgets)
const resolvedSections = await resolveSections(mergedSections, logger);

// Generate CLAUDE.md
const claudeMd = generateClaudeMd(profile, session, mcpUrl, {
  injectedSections: resolvedSections,
  injectedMcpServers: mergedMcpServers,
});
await containerManager.writeFile(containerId, '/workspace/CLAUDE.md', claudeMd);

// Build MCP server list for runtime
const mcpServers: McpServerConfig[] = [
  { name: 'escalation', url: mcpUrl },
  ...mergedMcpServers.map(s => ({ name: s.name, url: s.url, headers: s.headers })),
];

const events = runtime.spawn({
  sessionId,
  task: session.task,
  model: session.model,
  workDir: worktreePath,
  customInstructions: profile.customInstructions ?? undefined,
  env: { SESSION_ID: sessionId },
  mcpServers,
});
```

`SessionManagerDependencies` gets `daemonConfig`:

```typescript
export interface SessionManagerDependencies {
  // ... existing ...
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections'>;
}
```

### Profile Inheritance

**`packages/daemon/src/profiles/inheritance.ts`**:

Add `mcpServers` and `claudeMdSections` to `SPECIAL_MERGE_FIELDS`:

```typescript
// mcpServers: merge by name (parent first, child overrides)
resolved.mcpServers = mergeMcpServers(parent.mcpServers, child.mcpServers);

// claudeMdSections: merge by heading (parent first, child overrides)
resolved.claudeMdSections = mergeClaudeMdSections(parent.claudeMdSections, child.claudeMdSections);
```

### DB Migration

**`packages/daemon/src/db/migrations/002_session_injection.sql`**:

```sql
-- Add injection columns to profiles (stored as JSON arrays)
ALTER TABLE profiles ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN claude_md_sections TEXT NOT NULL DEFAULT '[]';
```

---

## Merge Semantics Summary

```
                   MCP Servers              CLAUDE.md Sections
                   ───────────              ──────────────────
Key:               name                     heading
Daemon sets:       defaults for all         defaults for all
Profile sets:      repo-specific            repo-specific
Merge rule:        profile entry with       profile entry with
                   same name overrides      same heading overrides
                   daemon entry             daemon entry
Inheritance:       same merge rule          same merge rule
                   across parent/child      across parent/child
                   profiles                 profiles
```

---

## Example: Prism Setup

### Daemon config (all repos get Prism MCP):

```json
{
  "mcpServers": [
    {
      "name": "prism",
      "url": "https://prism.internal/mcp",
      "headers": { "Authorization": "Bearer ${PRISM_API_KEY}" },
      "description": "Codebase context powered by Prism. Use these tools to understand the codebase before making changes.",
      "toolHints": [
        "Call `get_file_context` before modifying any file",
        "Call `get_related_files` to find blast radius of your changes",
        "Call `get_architecture_overview` for system-level orientation"
      ]
    }
  ]
}
```

### Profile config (repo-specific pre-loaded context):

```json
{
  "name": "my-frontend",
  "repoUrl": "https://github.com/org/my-frontend",
  "claudeMdSections": [
    {
      "heading": "Codebase Architecture",
      "priority": 10,
      "fetch": {
        "url": "https://prism.internal/api/projects/org/my-frontend/context/arch",
        "authorization": "Bearer prism_abc123",
        "body": { "maxTokens": 4000 },
        "timeoutMs": 10000
      },
      "maxTokens": 4000
    }
  ]
}
```

### Result: agent gets

1. **CLAUDE.md** with a `## Codebase Architecture` section (pre-loaded, priority 10 = near the top)
2. **Prism MCP server** available for runtime tool calls (file context, related files, change history, etc.)
3. **Escalation MCP server** as always

### Profile WITHOUT Prism:

```json
{
  "name": "simple-api",
  "repoUrl": "https://github.com/org/simple-api",
  "mcpServers": [],
  "claudeMdSections": []
}
```

Identical to current behavior. Both arrays default to `[]`.

---

## Other Use Cases (Not Just Prism)

The injection system is generic. Other things you could plug in:

| Use case | MCP server | CLAUDE.md section |
|----------|-----------|-------------------|
| **Prism** (codebase context) | `prism` MCP with 6 context tools | Pre-loaded architecture overview |
| **Internal docs API** | — | Fetch relevant docs at provisioning |
| **Compliance rules** | — | Static section: "Never do X, always do Y" |
| **Sentry/error tracker** | `sentry` MCP for querying errors | — |
| **Feature flag service** | `flags` MCP for checking flags | Pre-loaded current flag states |
| **Custom linter** | `lint` MCP for checking style | Static section with coding standards |

---

## File Change Summary

| File | Change |
|------|--------|
| `packages/shared/src/types/injection.ts` | **New** — `InjectedMcpServer`, `InjectedClaudeMdSection` types |
| `packages/shared/src/types/profile.ts` | Add `mcpServers` and `claudeMdSections` fields |
| `packages/shared/src/types/runtime.ts` | Add optional `headers` to `McpServerConfig` |
| `packages/shared/src/schemas/config.schema.ts` | Add `mcpServers` and `claudeMdSections` to daemon config |
| `packages/shared/src/schemas/profile.schema.ts` | Add injection schemas to profile schemas |
| `packages/daemon/src/db/migrations/002_session_injection.sql` | **New** — migration for profile columns |
| `packages/daemon/src/sessions/injection-merger.ts` | **New** — merge logic for daemon + profile injections |
| `packages/daemon/src/sessions/section-resolver.ts` | **New** — dynamic fetch + truncation for CLAUDE.md sections |
| `packages/daemon/src/sessions/claude-md-generator.ts` | Accept and render injected sections + MCP servers |
| `packages/daemon/src/sessions/session-manager.ts` | Merge, resolve, and pass injections during provisioning |
| `packages/daemon/src/profiles/inheritance.ts` | Add merge rules for new fields in profile inheritance |
| `packages/daemon/src/index.ts` | Pass daemon config injection fields to session manager |

---

## Secret Management

- **API keys in headers** stay in config (daemon env / profile DB row) — same trust boundary as `ANTHROPIC_API_KEY`
- **Keys in `fetch.authorization`** are used server-side during provisioning — never written to CLAUDE.md content
- **MCP server headers** are written to `.mcp.json` in the container — container is ephemeral and isolated
- Future consideration: support `${ENV_VAR}` interpolation in header values, resolved from daemon env at runtime

---

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Dynamic section fetch fails | Logged as warning. Section skipped (or falls back to static `content` if set). Session starts normally. |
| Dynamic section fetch times out | Same as failure — skipped with warning. Default timeout 10s. |
| MCP server unreachable at runtime | Agent tool calls fail. Agent can escalate. Session continues. |
| No injections configured | Identical to current behavior. Both arrays default to `[]`. |
| Profile overrides daemon MCP server with empty | Profile entry wins — effectively removes that server for this profile. |

---

## Implementation Order

1. **Types + schemas** — `InjectedMcpServer`, `InjectedClaudeMdSection`, zod schemas, `McpServerConfig.headers`
2. **DB migration** — new columns on profiles
3. **Injection merger** — merge logic with tests
4. **Section resolver** — dynamic fetch with tests (mock fetch)
5. **CLAUDE.md generator** — accept and render injected content
6. **SessionManager** — wire merge → resolve → generate pipeline
7. **Profile inheritance** — add merge rules for new fields
8. **Daemon wiring** — pass config to session manager
9. **End-to-end test** — configure Prism, run a session, verify CLAUDE.md and MCP config
