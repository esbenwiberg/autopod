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

  it('read-only compound inspections are measured', () => {
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
    expect(
      normalizeQualityActivityEvidence(bash("/bin/bash -lc 'sed -n 1,40p src/app.ts'")),
    ).toEqual({ activities: [], ambiguousInspection: true });
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
    expect(normalizeQualityActivityEvidence(bashArgv(['bash']))).toEqual({
      activities: [],
      ambiguousInspection: true,
    });
    expect(
      normalizeQualityActivityEvidence(bashArgv(['bash', '-lc', 'echo $(cat src/app.ts)'])),
    ).toEqual({ activities: [], ambiguousInspection: true });
    expect(
      normalizeQualityActivityEvidence(bashArgv(['sh', '-lc', 'echo `cat src/app.ts`'])),
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

  describe('segment-level shell evidence', () => {
    const evidence = (command: string, cwd = '/workspace') => {
      const result = normalizeQualityActivityEvidence(bash(command, cwd));
      return { paths: result.activities.map((a) => a.path), ambiguous: result.ambiguousInspection };
    };

    it('credits provable reads even when other segments are unprovable', () => {
      expect(
        evidence(
          'ls /autopod/spec/; cat /autopod/spec/contract.yaml | head -50; cd /workspace; sed -n 420,500p src/save.ts; grep -rn "needle" src --include=*.ts | grep -v test | head -40',
        ),
      ).toEqual({ paths: ['src/save.ts'], ambiguous: true });
      expect(evidence('npm test && cat src/a.ts; git status')).toEqual({
        paths: ['src/a.ts'],
        ambiguous: false,
      });
      expect(evidence('git status\ncat src/a.ts\n# cat src/commented.ts')).toEqual({
        paths: ['src/a.ts'],
        ambiguous: false,
      });
    });

    it('credits a read piped only through display filters', () => {
      expect(evidence('cat src/a.ts | head -20')).toEqual({
        paths: ['src/a.ts'],
        ambiguous: false,
      });
      expect(evidence("cat package.json | grep -n '\"test\\|lint'")).toEqual({
        paths: ['package.json'],
        ambiguous: false,
      });
      expect(evidence('sed -n 1,40p src/a.ts 2>/dev/null | nl | tail -n 5')).toEqual({
        paths: ['src/a.ts'],
        ambiguous: false,
      });
    });

    it.each([
      'cat src/a.ts | wc -l',
      'cat src/a.ts | grep needle src/b.ts',
      'cat src/a.ts | grep -r needle',
      'cat src/a.ts | sort -o src/sorted.ts',
      'cat src/a.ts | tee copy.ts',
      'find src -name a.ts | xargs cat',
    ])('does not credit reads through non-display pipelines: %s', (command) => {
      expect(evidence(command)).toEqual({ paths: [], ambiguous: true });
    });

    it('tracks literal cd targets and fails closed on unknown directories', () => {
      expect(evidence('cd packages/web && cat app.ts')).toEqual({
        paths: ['packages/web/app.ts'],
        ambiguous: false,
      });
      expect(evidence('cd /tmp; cat ../workspace/src/a.ts')).toEqual({
        paths: ['src/a.ts'],
        ambiguous: false,
      });
      expect(evidence('cd /tmp/notes; cat research.md')).toEqual({ paths: [], ambiguous: false });
      expect(evidence('cd $DIR; cat app.ts')).toEqual({ paths: [], ambiguous: true });
      expect(evidence('cd; cat app.ts')).toEqual({ paths: [], ambiguous: true });
    });

    it('treats paths outside the workspace as proven non-repository reads', () => {
      expect(evidence('cat /autopod/spec/contract.yaml')).toEqual({ paths: [], ambiguous: false });
      expect(evidence('tail -80 /tmp/test.log')).toEqual({ paths: [], ambiguous: false });
      expect(evidence('cat /workspace')).toEqual({ paths: [], ambiguous: true });
    });

    it('ignores heredoc bodies and does not treat heredoc writes as inspections', () => {
      expect(
        evidence(
          "cat > src/new.test.ts <<'EOF'\ncat src/secret.ts; sed -n 1p src/x.ts\nEOF\ncat src/a.ts",
        ),
      ).toEqual({ paths: ['src/a.ts'], ambiguous: false });
      expect(evidence('python3 - <<-EOF\n\tprint(open("src/a.ts").read())\n\tEOF')).toEqual({
        paths: [],
        ambiguous: false,
      });
      expect(evidence("cat > notes.md <<'EOF'\ncat src/a.ts")).toEqual({
        paths: [],
        ambiguous: false,
      });
    });

    it('does not credit reads that only run after a failure', () => {
      expect(evidence('test -f src/a.ts || cat src/b.ts; cat src/c.ts')).toEqual({
        paths: ['src/c.ts'],
        ambiguous: true,
      });
    });

    it('stops crediting after commands that can change command resolution', () => {
      expect(evidence('cat src/a.ts; export PATH=/tmp/bin; cat src/b.ts')).toEqual({
        paths: ['src/a.ts'],
        ambiguous: true,
      });
      expect(evidence('source env.sh && cat src/b.ts')).toEqual({ paths: [], ambiguous: true });
      expect(evidence('set -e; code=0; cat src/b.ts')).toEqual({
        paths: ['src/b.ts'],
        ambiguous: false,
      });
    });

    it('keeps subshells and command substitution opaque', () => {
      expect(evidence('cat src/a.ts; (cat src/b.ts)')).toEqual({
        paths: ['src/a.ts'],
        ambiguous: true,
      });
      expect(
        evidence('git stash; (npm run lint 2>&1 | tail -2); (npm run build | tail -4)'),
      ).toEqual({ paths: [], ambiguous: false });
      expect(evidence('echo "$(cat src/a.ts)"')).toEqual({ paths: [], ambiguous: true });
    });

    it('applies segment evaluation inside structured shell wrappers', () => {
      expect(
        normalizeQualityActivityEvidence(
          bashArgv(['/bin/bash', '-lc', 'npm test 2>&1 | tail -5; cat src/a.ts']),
        ),
      ).toMatchObject({ activities: [{ path: 'src/a.ts' }], ambiguousInspection: false });
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
