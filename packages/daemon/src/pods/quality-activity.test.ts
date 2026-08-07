import type { AgentEvent } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalRepositoryPath,
  normalizeQualityActivity,
  normalizeQualityActivityEvidence,
} from './quality-activity.js';

const bash = (command: string, cwd = '/workspace'): AgentEvent => ({
  type: 'tool_use',
  timestamp: '2026-01-01T00:00:00.000Z',
  tool: 'Bash',
  input: { call_id: 'call-1', command, cwd },
});

const bashArgv = (argv: string[], cwd = '/workspace'): AgentEvent => ({
  type: 'tool_use',
  timestamp: '2026-01-01T00:00:00.000Z',
  tool: 'Bash',
  input: { call_id: 'argv-call', command: argv.join(' '), argv, cwd },
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
    'cat src/*.ts',
    'cat ~/src/app.ts',
    'cat -- -',
    '/tmp/cat src/app.ts',
    './rg needle src/app.ts',
    'head -- -',
    "sed -n '1p' -",
    'rg needle -',
    "sed -i 's/a/b/' src/app.ts",
    "sed -n 'w owned.ts' src/app.ts",
    "sed -n '1e touch owned' src/app.ts",
    'rg needle .',
    'rg --files src',
    'cat /tmp/project/src/app.ts',
    'cat ../../outside.ts',
    'cat "unterminated',
  ])('rejects unknown, mutating, or ambiguous command %s', (command) => {
    expect(normalizeQualityActivity(bash(command))).toEqual([]);
  });

  it('wrapped-inspection-is-measured', () => {
    expect(
      normalizeQualityActivityEvidence(bash("/bin/bash -lc 'sed -n 1,40p src/app.ts'")),
    ).toEqual({
      activities: [
        {
          kind: 'inspection',
          path: 'src/app.ts',
          source: 'shell-command',
          callId: 'call-1',
        },
      ],
      ambiguousInspection: false,
    });
    expect(normalizeQualityActivity(bash(`/bin/bash -lc "rg -n 'foo|bar' src/search.ts"`))).toEqual(
      [
        {
          kind: 'inspection',
          path: 'src/search.ts',
          source: 'shell-command',
          callId: 'call-1',
        },
      ],
    );
    expect(normalizeQualityActivity(bash('cat src/a.ts && sed -n 1,20p src/b.ts'))).toEqual([
      {
        kind: 'inspection',
        path: 'src/a.ts',
        source: 'shell-command',
        callId: 'call-1',
      },
      {
        kind: 'inspection',
        path: 'src/b.ts',
        source: 'shell-command',
        callId: 'call-1',
      },
    ]);
  });

  it('structured-wrapper-inspection-is-measured', () => {
    expect(
      normalizeQualityActivity(bashArgv(['/bin/bash', '-lc', 'sed -n 1,40p src/app.ts'])),
    ).toEqual([
      {
        kind: 'inspection',
        path: 'src/app.ts',
        source: 'shell-command',
        callId: 'argv-call',
      },
    ]);
    expect(normalizeQualityActivity(bashArgv(['sed', '-n', '1,40p', 'src/direct.ts']))).toEqual([
      {
        kind: 'inspection',
        path: 'src/direct.ts',
        source: 'shell-command',
        callId: 'argv-call',
      },
    ]);
    expect(
      normalizeQualityActivity(bashArgv(['sh', '-lc', 'cat app.ts'], '/workspace/packages/web')),
    ).toEqual([
      {
        kind: 'inspection',
        path: 'packages/web/app.ts',
        source: 'shell-command',
        callId: 'argv-call',
      },
    ]);
  });

  it('ambiguous-inspection-is-unavailable', () => {
    const evidence = normalizeQualityActivityEvidence(bash('cat src/app.ts | wc -l'));
    expect(evidence.activities).toEqual([]);
    expect(evidence.ambiguousInspection).toBe(true);

    const flattenedWrapper = normalizeQualityActivityEvidence(
      bash('/bin/bash -lc sed -n 1,40p src/app.ts'),
    );
    expect(flattenedWrapper.activities).toEqual([]);
    expect(flattenedWrapper.ambiguousInspection).toBe(true);
  });

  it('unsafe-or-flattened-command-remains-unavailable', () => {
    expect(normalizeQualityActivityEvidence(bash('/bin/bash -lc sed -n 1,40p src/app.ts'))).toEqual(
      { activities: [], ambiguousInspection: true },
    );
    expect(normalizeQualityActivityEvidence(bash('sh -lc cat src/app.ts'))).toEqual({
      activities: [],
      ambiguousInspection: true,
    });
    expect(
      normalizeQualityActivityEvidence(bashArgv(['bash', '-lc', 'cat src/app.ts | wc -l'])),
    ).toEqual({ activities: [], ambiguousInspection: true });
    expect(
      normalizeQualityActivityEvidence(bashArgv(['bash', '-lc', 'sed -i s/a/b/ src/app.ts'])),
    ).toEqual({ activities: [], ambiguousInspection: true });
    expect(
      normalizeQualityActivityEvidence(bashArgv(['bash', '-lc', 'cat', 'src/app.ts'])),
    ).toEqual({ activities: [], ambiguousInspection: true });
    expect(
      normalizeQualityActivityEvidence({
        ...bash('cat src/app.ts'),
        input: { command: 'cat src/app.ts', argv: ['cat', 42] },
      } as AgentEvent),
    ).toEqual({ activities: [], ambiguousInspection: true });
    expect(normalizeQualityActivityEvidence(bashArgv(['cat', 'src/*.ts']))).toEqual({
      activities: [],
      ambiguousInspection: true,
    });
    expect(normalizeQualityActivityEvidence(bashArgv(['cat', 'src/$(touch owned)']))).toEqual({
      activities: [],
      ambiguousInspection: true,
    });
    expect(normalizeQualityActivityEvidence(bashArgv(['/usr/bin/cat', 'src/app.ts']))).toEqual({
      activities: [],
      ambiguousInspection: true,
    });
    expect(normalizeQualityActivityEvidence(bashArgv(['sh', '-lc', 'cat src/*.ts']))).toEqual({
      activities: [],
      ambiguousInspection: true,
    });
  });

  it('does not make unrelated compound commands ambiguous', () => {
    const evidence = normalizeQualityActivityEvidence(bash('npm test && git status'));
    expect(evidence).toEqual({ activities: [], ambiguousInspection: false });
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

  it('uses workdir when cwd is absent', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      timestamp: '2026-01-01T00:00:00.000Z',
      tool: 'Bash',
      input: {
        call_id: 'workdir-call',
        command: 'bash -lc cat app.ts',
        argv: ['bash', '-lc', 'cat app.ts'],
        workdir: '/workspace/packages/web',
      },
    };
    expect(normalizeQualityActivity(event)).toMatchObject([{ path: 'packages/web/app.ts' }]);
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
