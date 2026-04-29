import { describe, expect, it } from 'vitest';
import {
  buildBashrcHintBlock,
  buildWorkspaceToolsDoc,
  mergeBashrcHint,
} from './workspace-tools-doc.js';

describe('buildWorkspaceToolsDoc', () => {
  it('headlines validate_in_browser with a worked example', () => {
    const doc = buildWorkspaceToolsDoc({ httpServerNames: ['escalation'], stdioServerNames: [] });
    expect(doc).toContain('# Autopod workspace tools');
    expect(doc).toContain('validate_in_browser');
    expect(doc).toContain('http://localhost:3000/');
    expect(doc).toContain('checks:');
    expect(doc).toContain('localhost');
  });

  it('does not list "escalation" as a profile MCP server', () => {
    const doc = buildWorkspaceToolsDoc({ httpServerNames: ['escalation'], stdioServerNames: [] });
    expect(doc).not.toContain('## Profile MCP servers');
  });

  it('lists extra HTTP MCP servers from the profile', () => {
    const doc = buildWorkspaceToolsDoc({
      httpServerNames: ['escalation', 'github', 'jira'],
      stdioServerNames: [],
    });
    expect(doc).toContain('## Profile MCP servers');
    expect(doc).toContain('`github`');
    expect(doc).toContain('`jira`');
  });

  it('lists stdio code-intelligence servers when present', () => {
    const doc = buildWorkspaceToolsDoc({
      httpServerNames: ['escalation'],
      stdioServerNames: ['roslyn-codelens-mcp', 'serena'],
    });
    expect(doc).toContain('## Code intelligence');
    expect(doc).toContain('`roslyn-codelens-mcp`');
    expect(doc).toContain('`serena`');
  });

  it('omits empty sections when no extras are configured', () => {
    const doc = buildWorkspaceToolsDoc({ httpServerNames: ['escalation'], stdioServerNames: [] });
    expect(doc).not.toContain('## Profile MCP servers');
    expect(doc).not.toContain('## Code intelligence');
  });

  it('always ends with a trailing newline', () => {
    const doc = buildWorkspaceToolsDoc({ httpServerNames: ['escalation'], stdioServerNames: [] });
    expect(doc.endsWith('\n')).toBe(true);
  });
});

describe('buildBashrcHintBlock', () => {
  it('wraps the hint in sentinel markers and references the doc path', () => {
    const block = buildBashrcHintBlock('/home/autopod/.config/autopod/tools.md');
    expect(block).toContain('# >>> autopod-hint >>>');
    expect(block).toContain('# <<< autopod-hint <<<');
    expect(block).toContain('/home/autopod/.config/autopod/tools.md');
    expect(block).toContain('[autopod]');
  });

  it('only echoes when the doc file exists (no-op if missing)', () => {
    const block = buildBashrcHintBlock('/some/path');
    expect(block).toContain('if [ -f "/some/path" ]; then');
  });
});

describe('mergeBashrcHint', () => {
  const block = buildBashrcHintBlock('/home/autopod/.config/autopod/tools.md');

  it('appends to an empty bashrc', () => {
    const merged = mergeBashrcHint('', block);
    expect(merged).toBe(block);
  });

  it('appends below existing content when no markers present', () => {
    const existing = 'export FOO=bar\nalias ll="ls -la"\n';
    const merged = mergeBashrcHint(existing, block);
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged.endsWith(block)).toBe(true);
  });

  it('inserts a separator newline if the existing content lacks one', () => {
    const existing = 'export FOO=bar';
    const merged = mergeBashrcHint(existing, block);
    expect(merged).toBe(`${existing}\n${block}`);
  });

  it('replaces an existing hint block in place (idempotent)', () => {
    const existing = `export FOO=bar\n${block}export AFTER=1\n`;
    const merged = mergeBashrcHint(existing, block);
    expect(merged).toContain('export FOO=bar');
    expect(merged).toContain('export AFTER=1');
    // Should not double-up the markers
    const startCount = (merged.match(/>>> autopod-hint >>>/g) ?? []).length;
    expect(startCount).toBe(1);
  });

  it('replacing an old block with a new block produces only the new one', () => {
    const oldBlock = buildBashrcHintBlock('/old/path/tools.md');
    const newBlock = buildBashrcHintBlock('/new/path/tools.md');
    const existing = `# header\n${oldBlock}\n# footer\n`;
    const merged = mergeBashrcHint(existing, newBlock);
    expect(merged).toContain('/new/path/tools.md');
    expect(merged).not.toContain('/old/path/tools.md');
    expect(merged).toContain('# header');
    expect(merged).toContain('# footer');
  });
});
