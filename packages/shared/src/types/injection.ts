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
