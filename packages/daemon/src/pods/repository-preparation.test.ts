import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryPreparationEvidence } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { ExecInterruptedError } from '../containers/exec-exit-evidence.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createMockContainerManager, createTestDb } from '../test-utils/mock-helpers.js';
import { PREPARATION_SOURCE_PROBE, prepareLaunchRepository } from './repository-preparation.js';

const exec = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const source = { head: 'a'.repeat(40), fingerprint: 'b'.repeat(64) };

async function fixture(command = 'pnpm install --frozen-lockfile') {
  const db = createTestDb();
  cleanups.push(() => db.close());
  const { services } = createTestConfiguration(db);
  const config = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: 'Fix',
      overrides: {
        repositorySetup: {
          prepareCommand: command,
          buildWorkDir: 'app',
          buildTimeout: 120,
          buildEnv: { PUBLIC_VALUE: { value: 'visible' }, PRIVATE_VALUE: { secretId: 's' } },
        },
      },
    },
    services,
  );
  const cm = createMockContainerManager();
  const result = { exitCode: 0 as number, stdout: '', stderr: '' };
  vi.mocked(cm.execInContainer).mockImplementation(async (_id, argv) =>
    argv[2] === PREPARATION_SOURCE_PROBE
      ? { exitCode: 0, stdout: JSON.stringify(source), stderr: '' }
      : result,
  );
  return { config, cm, result };
}

describe('repository preparation', () => {
  it('binds success to source and hashes commands without exposing env', async () => {
    const f = await fixture();
    const env = { PUBLIC_VALUE: 'visible', PRIVATE_VALUE: 'private-fixture' };
    const evidence = await prepareLaunchRepository(f.config, f.cm, 'candidate', env);
    expect(evidence).toMatchObject({
      status: 'passed',
      source,
      containerId: 'candidate',
      exitCode: 0,
    });
    expect(evidence.commandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain('private-fixture');
    expect(f.cm.execInContainer).toHaveBeenCalledWith(
      'candidate',
      [
        '/usr/bin/env',
        '--',
        'PUBLIC_VALUE=visible',
        'sh',
        '-c',
        'set -e\npnpm install --frozen-lockfile',
      ],
      {
        cwd: '/workspace/app',
        timeout: 120000,
        env,
        assertCurrent: expect.any(Function),
        requireObservedExit: true,
        maxOutputBytes: 65536,
      },
    );
  });

  it('preserves public literals when transport loses env, with secrets excluded from argv', async () => {
    const f = await fixture('test "$PUBLIC_VALUE" = visible && test -z "$PRIVATE_VALUE"');
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, argv) => {
      if (argv[2] === PREPARATION_SOURCE_PROBE)
        return { exitCode: 0, stdout: JSON.stringify(source), stderr: '' };
      expect(JSON.stringify(argv)).not.toContain('private-fixture');
      const output = await exec(argv[0]!, argv.slice(1), { env: { PATH: process.env.PATH } });
      return { ...output, exitCode: 0 };
    });
    expect(
      (
        await prepareLaunchRepository(f.config, f.cm, 'candidate', {
          PUBLIC_VALUE: 'visible',
          PRIVATE_VALUE: 'private-fixture',
        })
      ).status,
    ).toBe('passed');
  });

  it('retains bounded useful failure detail while removing credentials and command literals', async () => {
    const f = await fixture('tool --password embedded-command-secret');
    f.result.exitCode = 1;
    f.result.stderr =
      'Dependency checksum mismatch\n' +
      [
        'resolved-env-secret',
        Buffer.from('resolved-env-secret').toString('base64'),
        // Construct synthetic credential output without checking in an npmrc assignment.
        ['_authToken', 'registry-file-secret'].join('='),
        'opaque-registry-123',
        'https://user:password@registry.invalid/package?token=url-secret',
        'tool --password embedded-command-secret',
        '+ echo xtrace-only-secret',
        'x'.repeat(3000),
      ].join('\n');
    let evidence: RepositoryPreparationEvidence | undefined;
    const failure = await prepareLaunchRepository(
      f.config,
      f.cm,
      'candidate',
      { TOKEN: 'resolved-env-secret' },
      {
        sensitiveValues: ['opaque-registry-123'],
        record: (value) => {
          evidence = value;
        },
      },
    ).catch((error) => error as Error);
    const text = JSON.stringify([evidence, (failure as Error).message]);
    expect(failure).toBeInstanceOf(Error);
    expect(text).toContain('Dependency checksum mismatch');
    for (const secret of [
      'resolved-env-secret',
      'registry-file-secret',
      'url-secret',
      'password@',
      'embedded-command-secret',
      'xtrace-only-secret',
      'opaque-registry-123',
    ])
      expect(text).not.toContain(secret);
    expect(evidence?.detail?.length).toBeLessThanOrEqual(1200);
    expect(evidence?.status).toBe('failed');
  });

  it('keeps the failure verdict at the end of long output and public literal values', async () => {
    const f = await fixture('npm ci && npm run bootstrap && npm run verify:worker');
    f.result.exitCode = 1;
    f.result.stdout = [
      'added 369 packages, and audited 372 packages in 6s',
      'found 0 vulnerabilities',
      '> agent-pods@0.1.0 bootstrap',
      ...Array.from({ length: 200 }, (_, i) => `  restored package ${i} visible`),
      '> agent-pods@0.1.0 verify:worker',
    ].join('\n');
    f.result.stderr = 'Pinned Chromium must launch with its sandbox; specified check failed.';
    let evidence: RepositoryPreparationEvidence | undefined;
    await prepareLaunchRepository(
      f.config,
      f.cm,
      'candidate',
      { PUBLIC_VALUE: 'visible', PRIVATE_VALUE: 'private-fixture' },
      {
        record: (value) => {
          evidence = value;
        },
      },
    ).catch(() => undefined);
    const detail = evidence?.detail ?? '';
    expect(detail).toContain(
      'Pinned Chromium must launch with its sandbox; specified check failed.',
    );
    expect(detail).toContain('added 369 packages');
    expect(detail).toContain('agent-pods@0.1.0');
    expect(detail).toContain('restored package 199 visible');
    expect(detail).not.toContain('[truncated]');
    expect(detail.length).toBeLessThanOrEqual(1200);
    expect(evidence?.status).toBe('failed');
  });

  it('still hides secret env values and credential-length command words', async () => {
    const f = await fixture('deploy --key Zx9qwertyuiop && npm ci');
    f.result.exitCode = 1;
    f.result.stderr = `${'noise\n'.repeat(400)}used Zx9qwertyuiop with private-fixture then failed`;
    let evidence: RepositoryPreparationEvidence | undefined;
    await prepareLaunchRepository(
      f.config,
      f.cm,
      'candidate',
      { PUBLIC_VALUE: 'visible', PRIVATE_VALUE: 'private-fixture' },
      {
        record: (value) => {
          evidence = value;
        },
      },
    ).catch(() => undefined);
    const detail = evidence?.detail ?? '';
    expect(detail).toContain('then failed');
    expect(detail).not.toContain('Zx9qwertyuiop');
    expect(detail).not.toContain('private-fixture');
  });

  it.each([
    'unknown',
    'timeout',
    'transport',
  ] as const)('fails closed on %s without exposing exception payloads', async (kind) => {
    const f = await fixture();
    const original = vi.mocked(f.cm.execInContainer).getMockImplementation()!;
    vi.mocked(f.cm.execInContainer).mockImplementation(async (...args) => {
      if (args[1][2] === PREPARATION_SOURCE_PROBE) return original(...args);
      if (kind === 'unknown')
        return { stdout: '', stderr: 'not verified', exitCode: undefined as unknown as number };
      if (kind === 'timeout')
        throw new ExecInterruptedError({
          cause: 'timeout',
          cleanup: 'unverified',
          timeoutMs: 120000,
        });
      throw new Error(
        'Transport failed TOKEN=resolved-env-secret https://x.invalid/?token=url-secret',
      );
    });
    const record = vi.fn();
    await expect(
      prepareLaunchRepository(
        f.config,
        f.cm,
        'candidate',
        { TOKEN: 'resolved-env-secret' },
        { record },
      ),
    ).rejects.toMatchObject({ code: 'REPOSITORY_PREPARATION_FAILED' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unverified', exitCode: null }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('resolved-env-secret');
    expect(JSON.stringify(record.mock.calls)).not.toContain('url-secret');
  });

  it('keeps legacy no-prepare behavior explicit without probing or certifying source', async () => {
    const cm = createMockContainerManager();
    expect(await prepareLaunchRepository(null, cm, 'legacy', {})).toMatchObject({
      status: 'not-configured',
      source: null,
      commandHash: null,
    });
    expect(cm.execInContainer).not.toHaveBeenCalled();
  });

  it('fingerprints native source and lock changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'preparation-inputs-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await exec('git', ['init', '-q', root]);
    await writeFile(path.join(root, 'lock.json'), 'first');
    await writeFile(path.join(root, 'prepare.sh'), 'echo ready');
    await exec('git', ['-C', root, 'add', '.']);
    await exec('git', [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const script = PREPARATION_SOURCE_PROBE.replace(
      "const root='/workspace'",
      `const root=${JSON.stringify(root)}`,
    );
    const probe = async () =>
      JSON.parse((await exec(process.execPath, ['-e', script])).stdout) as typeof source;
    const before = await probe();
    await writeFile(path.join(root, 'lock.json'), 'second');
    expect((await probe()).fingerprint).not.toBe(before.fingerprint);
    await writeFile(path.join(root, 'lock.json'), 'first');
    expect(await probe()).toEqual(before);
    await writeFile(path.join(root, 'prepare.sh'), 'echo changed');
    expect((await probe()).fingerprint).not.toBe(before.fingerprint);
  });
});
