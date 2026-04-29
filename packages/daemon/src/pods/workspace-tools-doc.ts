export interface WorkspaceToolsDocOptions {
  /** Names of HTTP MCP servers injected into /workspace/.mcp.json (e.g. 'escalation', proxied profile servers). */
  httpServerNames: string[];
  /** Names of stdio MCP servers injected (e.g. 'roslyn-codelens-mcp', 'serena'). */
  stdioServerNames: string[];
}

/**
 * Markdown one-pager surfaced inside workspace pods so the user can discover
 * the MCP tools wired into `/workspace/.mcp.json`. Headlines `validate_in_browser`
 * because that's the one human users typically reach for to verify their dev server
 * without leaving the pod.
 */
export function buildWorkspaceToolsDoc(opts: WorkspaceToolsDocOptions): string {
  const otherHttpServers = opts.httpServerNames.filter((n) => n !== 'escalation');

  const lines: string[] = [];

  lines.push('# Autopod workspace tools');
  lines.push('');
  lines.push(
    'This pod has Autopod MCP tools wired up via `/workspace/.mcp.json`. Run `claude` from anywhere',
  );
  lines.push(
    'inside `/workspace` and the tools below show up automatically — no extra config needed.',
  );
  lines.push('');

  lines.push('## validate_in_browser — verify your dev server in a real browser');
  lines.push('');
  lines.push(
    'Spawns headless Chromium against a localhost URL, runs natural-language checks, and returns',
  );
  lines.push(
    'pass/fail with reasoning and a screenshot per check. Use it to sanity-check changes before',
  );
  lines.push('committing.');
  lines.push('');
  lines.push('Start your dev server inside this container, then call:');
  lines.push('');
  lines.push('```');
  lines.push('validate_in_browser({');
  lines.push('  url: "http://localhost:3000/",  // your dev server port');
  lines.push('  checks: [');
  lines.push('    "homepage renders the navigation bar without console errors",');
  lines.push('    "clicking the Settings link navigates to /settings",');
  lines.push('  ],');
  lines.push('})');
  lines.push('```');
  lines.push('');
  lines.push(
    'URLs are restricted to `localhost` / `127.0.0.1` — the tool is for self-validation, not',
  );
  lines.push('general web browsing.');
  lines.push('');

  lines.push('## Other tools available');
  lines.push('');
  lines.push('- `ask_ai` — consult a different model on a tricky decision');
  lines.push('- `memory_search` / `memory_read` / `memory_list` — query persistent memory');
  lines.push(
    '- `execute_action` — run profile-defined control-plane actions (Azure / ADO / GitHub / HTTP)',
  );

  if (otherHttpServers.length > 0) {
    lines.push('');
    lines.push('## Profile MCP servers');
    lines.push('');
    lines.push(
      'Tools from these are also exposed by `/workspace/.mcp.json` and proxied through the daemon:',
    );
    lines.push('');
    for (const name of otherHttpServers) {
      lines.push(`- \`${name}\``);
    }
  }

  if (opts.stdioServerNames.length > 0) {
    lines.push('');
    lines.push('## Code intelligence (stdio MCP servers)');
    lines.push('');
    for (const name of opts.stdioServerNames) {
      lines.push(`- \`${name}\``);
    }
  }

  return `${lines.join('\n')}\n`;
}

const HINT_START = '# >>> autopod-hint >>>';
const HINT_END = '# <<< autopod-hint <<<';

/**
 * Build a sentinel-wrapped block to append to the container user's `.bashrc`
 * so an interactive shell prints a single-line hint on entry.
 *
 * Idempotent via the START/END markers — call `mergeBashrcHint` to splice it
 * into existing bashrc content without duplicating.
 */
export function buildBashrcHintBlock(toolsDocPath: string): string {
  return [
    HINT_START,
    `if [ -f "${toolsDocPath}" ]; then`,
    `  echo "[autopod] MCP tools available — run 'cat ${toolsDocPath}' for usage (validate_in_browser, ask_ai, ...)."`,
    'fi',
    HINT_END,
    '',
  ].join('\n');
}

/**
 * Merge the hint block into existing bashrc content. If the sentinel markers
 * already exist, replaces the block in place. Otherwise appends.
 */
export function mergeBashrcHint(existing: string, hintBlock: string): string {
  const startIdx = existing.indexOf(HINT_START);
  const endIdx = existing.indexOf(HINT_END);

  if (startIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + HINT_END.length);
    const trimmedAfter = after.startsWith('\n') ? after.slice(1) : after;
    return `${before}${hintBlock}${trimmedAfter}`;
  }

  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return `${existing}${sep}${hintBlock}`;
}
