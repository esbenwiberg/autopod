import type { AgentEvent } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { canonicalRepositoryPath, normalizeQualityActivity } from './quality-activity.js';

const bash = (command: string, cwd = '/workspace'): AgentEvent => ({
  type: 'tool_use',
  timestamp: '2026-01-01T00:00:00.000Z',
  tool: 'Bash',
  input: { call_id: 'call-1', command, cwd },
});

describe('normalizeQualityActivity', () => {
  it.each([
    ['cat packages/daemon/src/index.ts', ['packages/daemon/src/index.ts']],
    ['cat "path with spaces/a.ts" other.ts', ['path with spaces/a.ts', 'other.ts']],
    ["sed -n '1,40p' ./src/app.ts", ['src/app.ts']],
    ['head -n 20 /workspace/src/app.ts', ['src/app.ts']],
    ['tail -10 src/app.ts', ['src/app.ts']],
    ["rg 'needle' src/app.ts src/lib.ts", ['src/app.ts', 'src/lib.ts']],
  ])('recognizes read-only command %s', (command, expected) => {
    expect(normalizeQualityActivity(bash(command))).toEqual(
      expected.map((path) => ({
        kind: 'inspection',
        path,
        source: 'shell-command',
        callId: 'call-1',
      })),
    );
  });

  it.each([
    'ls src/app.ts',
    'cat src/app.ts | wc -l',
    'cat $(touch owned)',
    'cat src/app.ts > copy.ts',
    "sed -i 's/a/b/' src/app.ts",
    'rg needle .',
    'rg --files src',
    'cat /tmp/project/src/app.ts',
    'cat ../../outside.ts',
    'cat "unterminated',
  ])('rejects unknown, mutating, or ambiguous command %s', (command) => {
    expect(normalizeQualityActivity(bash(command))).toEqual([]);
  });

  it('uses the Codex working directory for relative operands', () => {
    expect(normalizeQualityActivity(bash('cat app.ts', '/workspace/packages/web'))).toEqual([
      {
        kind: 'inspection',
        path: 'packages/web/app.ts',
        source: 'shell-command',
        callId: 'call-1',
      },
    ]);
  });

  it('normalizes native lowercase read, edit, and write tools', () => {
    const event = (tool: string, path: string): AgentEvent => ({
      type: 'tool_use',
      timestamp: '2026-01-01T00:00:00.000Z',
      tool,
      input: { call_id: `${tool}-1`, path },
    });
    expect(normalizeQualityActivity(event('read', '/workspace/src/a.ts'))).toEqual([
      {
        kind: 'inspection',
        path: 'src/a.ts',
        source: 'native-tool',
        callId: 'read-1',
      },
    ]);
    expect(normalizeQualityActivity(event('edit', 'src/a.ts'))[0]).toMatchObject({
      kind: 'mutation',
      path: 'src/a.ts',
      action: 'modify',
    });
    expect(normalizeQualityActivity(event('write', './src/new.ts'))[0]).toMatchObject({
      kind: 'mutation',
      path: 'src/new.ts',
      action: 'write',
    });
  });

  it('normalizes file changes into mutation evidence', () => {
    expect(
      normalizeQualityActivity({
        type: 'file_change',
        timestamp: '2026-01-01T00:00:00.000Z',
        path: '/workspace/src/a.ts',
        action: 'modify',
      }),
    ).toEqual([{ kind: 'mutation', path: 'src/a.ts', action: 'modify', source: 'file-change' }]);
  });
});

describe('canonicalRepositoryPath', () => {
  it('gives relative and workspace paths the same identity', () => {
    expect(canonicalRepositoryPath('./packages/daemon/src/index.ts')).toBe(
      'packages/daemon/src/index.ts',
    );
    expect(canonicalRepositoryPath('/workspace/packages/daemon/src/index.ts')).toBe(
      'packages/daemon/src/index.ts',
    );
  });

  it('does not equate unrelated absolute paths through suffix matching', () => {
    expect(canonicalRepositoryPath('/tmp/copy/packages/daemon/src/index.ts')).toBeNull();
  });

  it('normalizes separators and components without permitting workspace escape', () => {
    expect(canonicalRepositoryPath('packages\\daemon\\src\\..\\index.ts')).toBe(
      'packages/daemon/index.ts',
    );
    expect(canonicalRepositoryPath('../../etc/passwd')).toBeNull();
  });
});
