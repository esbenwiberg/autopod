import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepoScanner } from '../security/repo-scanner.js';
import { getPreset } from '../security/scan-policy.js';
import {
  describePublicationScan,
  publicationScanError,
  scanSavedWorkPublication,
} from './saved-work-publication-scan.js';

const logger = pino({ level: 'silent' });
// Synthetic values, assembled at runtime so this file holds no scannable literal.
const fakeAwsKey = ['AKIAQ4Z9PX', 'R7DNV3HM2L'].join('');
const fixtureAuthUrl = ['https://user', ':token', '@github.com/acme/repo.git'].join('');

describe('saved-work publication scan', () => {
  let repo: string;
  let base: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
      .toString()
      .trim();
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'saved-work-publication-scan-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    git('config', 'commit.gpgsign', 'false');
    // Pre-existing base content a full-tree secretlint scan flags (cf. test
    // fixtures with basic-auth URLs). Gitleaks with repository config may ignore it.
    write('tests/auth-fixture.test.ts', `const url = '${fixtureAuthUrl}';\n`);
    write('docs/index.md', '# Docs\n\n- [Intro](intro.md)\n');
    write('docs/intro.md', '# Intro\n');
    base = commit('base');
    git('checkout', '-q', '-b', 'feature');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const scanner = () => createRepoScanner({ logger });

  it('does not block a clean docs-only change because of findings already in the base', async () => {
    write('docs/guide.md', '# Guide\n\nHow to run the thing.\n');
    write('docs/index.md', '# Docs\n\n- [Intro](intro.md)\n- [Guide](guide.md)\n');
    commit('docs: add guide');

    const result = await scanSavedWorkPublication({
      scanner: scanner(),
      podId: 'pod-1',
      worktree: repo,
      policy: getPreset('default'),
      baseCommit: base,
    });

    expect(result).toMatchObject({
      outcome: 'passed',
      code: null,
      scope: 'diff',
      baseCommit: base,
      findingCount: 0,
      reasons: [],
    });
    expect(result.filesScanned).toBe(2);
  });

  it('reports scanner, rule and redacted file:line for an introduced finding', async () => {
    write('docs/guide.md', `# Guide\n\nUse key ${fakeAwsKey} here.\n`);
    commit('docs: add guide');

    const result = await scanSavedWorkPublication({
      scanner: scanner(),
      podId: 'pod-1',
      worktree: repo,
      policy: getPreset('default'),
      baseCommit: base,
    });

    expect(result.outcome).toBe('blocked');
    expect(result.code).toBe('SECURITY_SCAN_BLOCKED');
    expect(result.blockingCount).toBe(1);
    expect(result.findings[0]).toEqual({
      scanner: 'secretlint',
      detector: 'secrets',
      ruleId: '@secretlint/secretlint-rule-aws',
      severity: expect.any(String),
      file: 'docs/guide.md',
      line: 3,
      action: 'block',
    });
    const error = publicationScanError(result);
    expect(error.code).toBe('SECURITY_SCAN_BLOCKED');
    expect(error.message).toContain('blocked by 1 finding(s)');
    expect(error.message).toContain(
      'secretlint rule @secretlint/secretlint-rule-aws at docs/guide.md:3',
    );
    expect(error.message).toContain(`base ${base.slice(0, 12)}`);
    expect(JSON.stringify(result)).not.toContain(fakeAwsKey);
    expect(JSON.stringify(result)).not.toContain(fakeAwsKey.slice(0, 4));
    expect(error.message).not.toContain(fakeAwsKey);
  });

  it('keeps full-tree coverage without a verified base and explains base findings', async () => {
    write('docs/guide.md', '# Guide\n');
    commit('docs: add guide');

    const result = await scanSavedWorkPublication({
      scanner: scanner(),
      podId: 'pod-1',
      worktree: repo,
      policy: getPreset('default'),
      baseCommit: null,
    });

    expect(result).toMatchObject({ outcome: 'blocked', scope: 'full', baseCommit: null });
    expect(result.findings).toEqual([
      expect.objectContaining({
        ruleId: '@secretlint/secretlint-rule-basicauth',
        file: 'tests/auth-fixture.test.ts',
        line: 1,
      }),
    ]);
    const message = describePublicationScan(result);
    expect(message).toContain('full tree');
    expect(message).not.toContain(fixtureAuthUrl);
    expect(JSON.stringify(result)).not.toContain(':token@');
  });

  it('honours a profile that configures full-tree push scans', async () => {
    write('docs/guide.md', '# Guide\n');
    commit('docs: add guide');
    const policy = getPreset('default');
    policy.push.scope = 'full';

    const result = await scanSavedWorkPublication({
      scanner: scanner(),
      podId: 'pod-1',
      worktree: repo,
      policy,
      baseCommit: base,
    });

    expect(result).toMatchObject({ outcome: 'blocked', scope: 'full', baseCommit: null });
  });

  it('reports a scan that could not list files as incomplete, not as a pass', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'saved-work-publication-plain-'));
    try {
      writeFileSync(path.join(plain, 'notes.md'), 'not a repository\n');
      const result = await scanSavedWorkPublication({
        scanner: scanner(),
        podId: 'pod-1',
        worktree: plain,
        policy: getPreset('default'),
      });
      expect(result).toMatchObject({
        outcome: 'incomplete',
        code: 'SECURITY_SCAN_INCOMPLETE',
        reasons: ['Could not list repository files to scan.'],
      });
      expect(publicationScanError(result).message).toContain(
        'did not complete within its required coverage',
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('distinguishes a scanner that could not run from a blocking finding', async () => {
    const result = await scanSavedWorkPublication({
      scanner: {
        scan: async () => {
          throw new Error('detector model unavailable');
        },
      },
      podId: 'pod-1',
      worktree: repo,
      policy: getPreset('default'),
      baseCommit: base,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      code: 'SECURITY_SCAN_FAILED',
      decision: null,
      reasons: ['Scanner error: detector model unavailable'],
    });
    const error = publicationScanError(result);
    expect(error.code).toBe('SECURITY_SCAN_FAILED');
    expect(error.message).toContain('could not run');
  });
});
