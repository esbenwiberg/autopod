/**
 * An MCP server to inject into agent sessions.
 * Configured at daemon level (applies to all sessions) or profile level (repo-specific).
 *
 * Two transports are supported:
 * - 'http' (default): daemon proxies the server URL into the container; auth headers injected by proxy
 * - 'stdio': a local binary spawned inside the container by Claude Code; written to .mcp.json directly
 */
export type InjectedMcpServer = HttpInjectedMcpServer | StdioInjectedMcpServer;

export interface HttpInjectedMcpServer {
  type?: 'http';
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

export interface StdioInjectedMcpServer {
  type: 'stdio';
  /** Unique name — used as key for merge/override between daemon and profile */
  name: string;
  /** Binary command to execute inside the container */
  command: string;
  /** Arguments passed to the command */
  args?: string[];
  /** Additional environment variables for the subprocess */
  env?: Record<string, string>;
  /** Human-readable description of what this server provides (injected into CLAUDE.md) */
  description?: string;
  /** Tool usage hints for the agent (injected into CLAUDE.md guidelines) */
  toolHints?: string[];
}

/**
 * A Claude Code skill to inject into agent sessions.
 * Written to `.claude/skills/<name>/SKILL.md` in the container — Claude Code 2.x
 * registers this as both an auto-triggerable skill and a `/name` slash command,
 * so a single write covers both invocation paths.
 */
export interface InjectedSkill {
  /** Unique name — used as the skill directory name, slash-command name, and merge key */
  name: string;
  /** Where to source the skill content from */
  source: LocalSkillSource | GithubSkillSource;
  /** Human-readable description (shown in CLAUDE.md) */
  description?: string;
}

export interface LocalSkillSource {
  type: 'local';
  /** Absolute path on daemon host to the skill .md file */
  path: string;
}

export interface GithubSkillSource {
  type: 'github';
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Path within the repo to the skill .md file (default: skill name + .md) */
  path?: string;
  /** Git ref — branch, tag, or commit SHA (default: main) */
  ref?: string;
  /** Optional GitHub token for private repos */
  token?: string;
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
