import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryPreparationEvidence } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { ExecInterruptedError } from '../containers/exec-exit-evidence.js';
import { RoutingContainerManager } from '../containers/routing-container-manager.js';
import type { SandboxApiClient } from '../containers/sandbox-api-client.js';
import { runSandboxObservedExec } from '../containers/sandbox-observed-exec.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createMockContainerManager, createTestDb } from '../test-utils/mock-helpers.js';
import { CACHE_SIGNAL_SCRIPT } from './preparation-timing.js';
import {
  commandNamedPaths,
  OUTSIDE_WORKSPACE_WRITES_SCRIPT,
  PREPARATION_DEPENDENCY_PROBE,
  PREPARATION_SOURCE_PROBE,
  prepareLaunchRepository,
} from './repository-preparation.js';

const exec = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
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
  it.each([
    'success',
    'nonzero',
    'lost',
    'mismatch',
    'timeout',
    'cancelled',
    'lost-start',
  ] as const)('observes one long Sandbox preparation through bounded RPCs: %s', async (scenario) => {
    const f = await fixture('sleep 35 && echo prepared');
    vi.useFakeTimers();
    const started = Date.now();
    let launches = 0;
    let stopped = false;
    let root = '';
    const requests = vi.fn<SandboxApiClient['exec']>(async (id, argv, options) => {
      expect(id).toBe('candidate');
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(5000);
      expect(options?.maxOutputBytes).toBe(100000);
      expect(options?.singleAttempt).toBe(true);
      options?.beforeSend?.();
      if (argv.at(-1) === '--detach') {
        launches++;
        if (scenario === 'lost-start') throw new Error('Lost launch response');
      } else if (argv[3]?.includes('os.mkdir')) {
        root = argv[4] ?? '';
      } else if (argv[3]?.includes('.touch(')) {
        stopped = true;
      } else if (argv[3]?.includes('read_text')) {
        expect(argv.at(-1)).toBe(`${root}/state.json`);
        const terminal = stopped || (scenario !== 'timeout' && Date.now() - started >= 35000);
        if (scenario === 'lost' && terminal) throw new Error('Lost terminal observation');
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            execId:
              scenario === 'mismatch' && terminal
                ? 'other-execution'
                : root.slice('/run/autopod-goal-exec-'.length),
            observedExit: terminal,
            ...(terminal
              ? {
                  exitCode: stopped ? 143 : scenario === 'nonzero' ? 7 : 0,
                  output: { stdout: Buffer.from('prepared').toString('base64'), stderr: '' },
                  timedOut: false,
                }
              : {}),
          }),
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const client = { supportsBoundedExec: true, exec: requests } as unknown as SandboxApiClient;
    const sandbox = { ...f.cm, execObserved: runSandboxObservedExec.bind(null, client) };
    const cm = new RoutingContainerManager({
      local: f.cm,
      sandbox,
      resolveTarget: () => 'sandbox',
    });
    const record = vi.fn();
    const outcome = prepareLaunchRepository(
      f.config,
      cm,
      'candidate',
      {},
      {
        record,
        assertCurrent() {
          if (scenario === 'cancelled' && Date.now() - started >= 1000)
            throw new Error('Ownership revoked');
        },
      },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(126000);
    const result = await outcome;
    expect(launches).toBe(1);
    if (scenario === 'success') {
      expect(result).toMatchObject({
        status: 'passed',
        exitCode: 0,
        source,
        timing: { commandMs: 35000 },
      });
      expect(stopped).toBe(false);
    } else {
      expect(result).toBeInstanceOf(Error);
      expect(stopped).toBe(scenario !== 'nonzero');
      if (scenario !== 'cancelled')
        expect(record).toHaveBeenCalledWith(
          expect.objectContaining({
            status: scenario === 'nonzero' ? 'failed' : 'unverified',
            exitCode: scenario === 'nonzero' ? 7 : null,
          }),
        );
    }
  });

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
        expect.stringMatching(
          /^set -e\n__autopod_prep_mark\(\) [^\n]+\ntrap '__autopod_prep_mark end' EXIT\n__autopod_prep_mark 1\npnpm install --frozen-lockfile$/,
        ),
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
    let commandsRun = 0;
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, argv) => {
      if (argv[2] === PREPARATION_SOURCE_PROBE)
        return { exitCode: 0, stdout: JSON.stringify(source), stderr: '' };
      expect(JSON.stringify(argv)).not.toContain('private-fixture');
      // Stub container-only probes that sleep, scan host directories or use
      // package tools. Keep the timing-file read to clean up the real command.
      if (argv[0] === 'sh' && argv[3] === 'autopod-prep-timing') {
        const output = await exec(argv[0], argv.slice(1));
        return { ...output, exitCode: 0 };
      }
      if (argv[0] !== '/usr/bin/env') return { exitCode: 0, stdout: '', stderr: '' };
      commandsRun++;
      const output = await exec(argv[0], argv.slice(1), { env: { PATH: process.env.PATH } });
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
    expect(commandsRun).toBe(1);
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

  function timedExec(
    f: Awaited<ReturnType<typeof fixture>>,
    markers: string | null,
    cacheLines = 'absent\nabsent\nabsent\nabsent\nabsent\nabsent\nabsent',
  ) {
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, argv) => {
      if (argv[2] === PREPARATION_SOURCE_PROBE)
        return { exitCode: 0, stdout: JSON.stringify(source), stderr: '' };
      if (argv[2] === CACHE_SIGNAL_SCRIPT) return { exitCode: 0, stdout: cacheLines, stderr: '' };
      if (String(argv[2]).startsWith('cat -- "$1"'))
        return markers === null
          ? { exitCode: 1, stdout: '', stderr: '' }
          : { exitCode: 0, stdout: markers, stderr: '' };
      return f.result;
    });
  }

  it('records per-stage durations and cache signals for a passing run', async () => {
    const f = await fixture('npm ci && npm run bootstrap && node scripts/probe.mjs');
    timedExec(
      f,
      '1 100.00\n2 801.50\n3 838.00\nend 842.25\n',
      ['present', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent'].join('\n'),
    );
    const record = vi.fn();
    const evidence = await prepareLaunchRepository(
      f.config,
      f.cm,
      'candidate',
      {},
      {
        record,
        preflightMs: 1500,
      },
    );
    expect(evidence.status).toBe('passed');
    expect(evidence.timing).toMatchObject({
      preflightMs: 1500,
      stageTiming: 'measured',
      stages: [
        { index: 1, label: 'npm ci', durationMs: 701500, status: 'passed' },
        { index: 2, label: 'npm run bootstrap', durationMs: 36500, status: 'passed' },
        { index: 3, label: 'node scripts/probe.mjs', durationMs: 4250, status: 'passed' },
      ],
    });
    expect(evidence.timing?.totalMs).toEqual(expect.any(Number));
    expect(evidence.timing?.commandMs).toEqual(expect.any(Number));
    expect(evidence.timing?.sourceProbeMs).toEqual(expect.any(Number));
    expect(evidence.cache?.signals[0]).toEqual({ name: 'npm-cache', state: 'present' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ timing: evidence.timing }));
    const script = vi
      .mocked(f.cm.execInContainer)
      .mock.calls.map(([, argv]) => argv)
      .find((argv) => String(argv.at(-1)).startsWith('set -e'));
    expect(script?.at(-1)).toContain(
      '__autopod_prep_mark 1 && npm ci && __autopod_prep_mark 2 && npm run bootstrap && __autopod_prep_mark 3 && node scripts/probe.mjs',
    );
  });

  it('records the failing stage with unchanged failure detail', async () => {
    const run = async (markers: string | null) => {
      const f = await fixture('npm ci && npm run bootstrap && npm run verify');
      f.result.exitCode = 2;
      f.result.stderr = 'bootstrap exploded';
      timedExec(f, markers);
      let evidence: RepositoryPreparationEvidence | undefined;
      const error = await prepareLaunchRepository(
        f.config,
        f.cm,
        'candidate',
        {},
        {
          record: (value) => {
            evidence = value;
          },
        },
      ).catch((e: Error) => e);
      return { evidence, error };
    };
    const timed = await run('1 10.00\n2 20.00\nend 95.50\n');
    const untimed = await run(null);
    expect(timed.error).toBeInstanceOf(Error);
    expect(timed.evidence).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(timed.evidence?.timing?.stages).toEqual([
      { index: 1, label: 'npm ci', durationMs: 10000, status: 'passed' },
      { index: 2, label: 'npm run bootstrap', durationMs: 75500, status: 'failed' },
      { index: 3, label: 'npm run verify', durationMs: null, status: 'not-run' },
    ]);
    expect(timed.evidence?.detail).toBe(untimed.evidence?.detail);
    expect((timed.error as Error).message).toBe((untimed.error as Error).message);
    expect(untimed.evidence?.timing?.stageTiming).toBe('unavailable');
  });

  it('records timing with every stage not run when the source probe fails first', async () => {
    const f = await fixture('npm ci && npm test');
    vi.mocked(f.cm.execInContainer).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    const record = vi.fn();
    await expect(
      prepareLaunchRepository(f.config, f.cm, 'candidate', {}, { record }),
    ).rejects.toThrow();
    expect(record.mock.calls[0]?.[0].timing).toMatchObject({
      commandMs: null,
      stages: [
        { index: 1, status: 'not-run' },
        { index: 2, status: 'not-run' },
      ],
    });
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

  it.each([
    [
      'deadline',
      'Source inputs unverified after preparation: source fingerprint exceeded its 24s read budget.',
    ],
    [
      'transport',
      'Source inputs unverified after preparation: source probe transport timed out (28s).',
    ],
    [
      'malformed',
      'Source inputs unverified after preparation: source probe returned invalid evidence.',
    ],
    ['changed-head', 'Git HEAD changed during preparation.'],
    ['changed-files', 'Source/dependency file fingerprint changed during preparation.'],
  ] as const)('records post-command %s without admitting source or exposing probe output', async (scenario, detail) => {
    const f = await fixture('npm ci');
    const original = vi.mocked(f.cm.execInContainer).getMockImplementation();
    if (!original) throw new Error('Missing fixture exec');
    const record = vi.fn();
    let probes = 0;
    vi.mocked(f.cm.execInContainer).mockImplementation(async (...args) => {
      if (args[1][2] !== PREPARATION_SOURCE_PROBE || ++probes === 1) return original(...args);
      expect(args[2]).toMatchObject({
        timeout: 28_000,
        requireObservedExit: true,
        maxOutputBytes: 4096,
      });
      if (scenario === 'transport')
        throw new ExecInterruptedError({
          cause: 'timeout',
          timeoutMs: 28_000,
          cleanup: 'unverified',
        });
      if (scenario === 'deadline' || scenario === 'malformed')
        return {
          exitCode: scenario === 'deadline' ? 20 : 0,
          stdout: 'private fixture stdout',
          stderr: 'private fixture stderr',
        };
      const after =
        scenario === 'changed-head'
          ? { ...source, head: 'e'.repeat(40) }
          : { ...source, fingerprint: 'e'.repeat(64) };
      return { exitCode: 0, stdout: JSON.stringify(after), stderr: '' };
    });
    await expect(
      prepareLaunchRepository(f.config, f.cm, 'candidate', {}, { record }),
    ).rejects.toThrow(detail);
    expect(probes).toBe(2);
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'unverified', detail, source, exitCode: 0 }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('private fixture');
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
    const slowProbe = script
      .replaceAll('performance.now()', 'fixtureNow')
      .replace('const fs=', 'let fixtureNow=0; const fs=')
      .replace('const hash=', 'fixtureNow=Number(process.argv[1]); const hash=');
    // A real read of the same files with a simulated slow Git/inventory phase.
    const slow = await exec(process.execPath, ['-e', slowProbe, '13000']);
    expect(JSON.parse(slow.stdout)).toEqual(before);
    await expect(exec(process.execPath, ['-e', slowProbe, '24000'])).rejects.toMatchObject({
      code: 20,
      stdout: '',
    });
    await writeFile(path.join(root, 'lock.json'), 'second');
    expect((await probe()).fingerprint).not.toBe(before.fingerprint);
    await writeFile(path.join(root, 'lock.json'), 'first');
    expect(await probe()).toEqual(before);
    await writeFile(path.join(root, 'prepare.sh'), 'echo changed');
    expect((await probe()).fingerprint).not.toBe(before.fingerprint);
  });

  it('fingerprints dependency manifests and command-named files, not other source', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'preparation-deps-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await exec('git', ['init', '-q', root]);
    await exec('mkdir', ['-p', path.join(root, 'scripts'), path.join(root, 'node_modules/x')]);
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    await writeFile(path.join(root, 'package-lock.json'), '{"v":1}');
    await writeFile(path.join(root, 'scripts/bootstrap.sh'), 'echo boot');
    await writeFile(path.join(root, 'src.ts'), 'export {}');
    await writeFile(path.join(root, 'node_modules/x/package.json'), '{}');
    const script = PREPARATION_DEPENDENCY_PROBE.replace(
      "const root='/workspace'",
      `const root=${JSON.stringify(root)}`,
    );
    const command = 'npm ci && sh scripts/bootstrap.sh';
    const probe = async () =>
      (
        JSON.parse(
          (await exec(process.execPath, ['-e', script, '.', ...commandNamedPaths(command)])).stdout,
        ) as { fingerprint: string }
      ).fingerprint;
    const before = await probe();
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(path.join(root, 'src.ts'), 'export const changed = 1');
    await writeFile(path.join(root, 'node_modules/x/package.json'), '{"edited":true}');
    expect(await probe()).toBe(before);
    await writeFile(path.join(root, 'package-lock.json'), '{"v":2}');
    const lockChanged = await probe();
    expect(lockChanged).not.toBe(before);
    await writeFile(path.join(root, 'scripts/bootstrap.sh'), 'echo changed');
    expect(await probe()).not.toBe(lockChanged);
  });

  it('extracts only relative path-like command words', () => {
    expect(
      commandNamedPaths('npm ci && ./scripts/boot.sh --flag && node tools/probe.mjs /etc/passwd'),
    ).toEqual(['./scripts/boot.sh', 'tools/probe.mjs']);
  });

  it('detects writes outside the workspace after the marker and prunes package caches', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'preparation-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const script = OUTSIDE_WORKSPACE_WRITES_SCRIPT.replace(' /usr/local /opt /workspace/.git', '');
    const run = async () => {
      const marker = path.join(home, '..', `${path.basename(home)}.marker`);
      await writeFile(marker, '');
      cleanups.push(() => rm(marker, { force: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return marker;
    };
    let marker = await run();
    await exec('mkdir', ['-p', path.join(home, '.npm/_cacache')]);
    await writeFile(path.join(home, '.npm/_cacache/entry'), 'cache');
    const env = { ...process.env, HOME: home };
    expect((await exec('sh', ['-c', script, 'x', marker], { env })).stdout.trim()).toBe('none');
    marker = await run();
    await exec('mkdir', ['-p', path.join(home, '.cache/ms-playwright')]);
    await writeFile(path.join(home, '.cache/ms-playwright/chromium'), 'browser');
    expect((await exec('sh', ['-c', script, 'x', marker], { env })).stdout.trim()).toBe('detected');
    // A missing marker or a failing find never reads as "none".
    expect((await exec('sh', ['-c', script, 'x', `${marker}.gone`], { env })).stdout.trim()).toBe(
      'unverified',
    );
    marker = await run();
    const broken = script.replace('-cnewer', '-no-such-predicate');
    expect((await exec('sh', ['-c', broken, 'x', marker], { env })).stdout.trim()).toBe(
      'unverified',
    );
  });

  it('skips the prepare command when continuation reuse restores matching dependencies', async () => {
    const f = await fixture('npm ci && npm run bootstrap');
    const attempt = vi.fn(async () => ({
      reused: true as const,
      sourceContainerId: 'old-container',
      restoredArchives: 2,
      restoredBytes: 2048,
      restoreMs: 120,
    }));
    const recorded: RepositoryPreparationEvidence[] = [];
    const evidence = await prepareLaunchRepository(
      f.config,
      f.cm,
      'candidate',
      {},
      {
        reuse: { attempt },
        record: (e) => recorded.push(structuredClone(e)),
      },
    );
    expect(attempt).toHaveBeenCalledWith({
      commandHash: evidence.commandHash,
      configurationHash: evidence.configurationHash,
      dependencyInputs: null,
    });
    expect(evidence).toMatchObject({
      status: 'passed',
      source,
      exitCode: null,
      outsideWorkspaceWrites: 'none',
      reuse: {
        decision: 'reused',
        sourceContainerId: 'old-container',
        restoredArchives: 2,
        restoredBytes: 2048,
      },
    });
    expect(evidence.timing?.commandMs).toBeNull();
    const commands = vi.mocked(f.cm.execInContainer).mock.calls.map(([, argv]) => argv.join(' '));
    expect(commands.some((c) => c.includes('npm ci'))).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it('runs the full command and records the reason when reuse is refused', async () => {
    const f = await fixture('npm ci && npm run bootstrap');
    const evidence = await prepareLaunchRepository(
      f.config,
      f.cm,
      'candidate',
      {},
      {
        reuse: { attempt: async () => ({ reused: false, reason: 'dependency-inputs-changed' }) },
      },
    );
    expect(evidence).toMatchObject({
      status: 'passed',
      exitCode: 0,
      reuse: { decision: 'refused', reason: 'dependency-inputs-changed' },
    });
    const commands = vi.mocked(f.cm.execInContainer).mock.calls.map(([, argv]) => argv.join(' '));
    expect(commands.some((c) => c.includes('npm ci'))).toBe(true);
  });

  it('refuses a restore that changes source inputs and prepares in full', async () => {
    const f = await fixture('npm ci');
    let probes = 0;
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, argv) =>
      argv[2] === PREPARATION_SOURCE_PROBE
        ? {
            exitCode: 0,
            stdout: JSON.stringify(
              ++probes === 2 ? { ...source, fingerprint: 'c'.repeat(64) } : source,
            ),
            stderr: '',
          }
        : f.result,
    );
    const evidence = await prepareLaunchRepository(
      f.config,
      f.cm,
      'candidate',
      {},
      {
        reuse: {
          attempt: async () => ({
            reused: true,
            sourceContainerId: 'old',
            restoredArchives: 1,
            restoredBytes: 1,
            restoreMs: 1,
          }),
        },
      },
    );
    expect(evidence.reuse).toEqual({ decision: 'refused', reason: 'source-changed-after-restore' });
    expect(evidence.status).toBe('passed');
    expect(evidence.exitCode).toBe(0);
  });

  it('records outside-workspace writes and the dependency fingerprint on a full run', async () => {
    const f = await fixture('npm ci');
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, argv) => {
      if (argv[2] === PREPARATION_SOURCE_PROBE)
        return { exitCode: 0, stdout: JSON.stringify(source), stderr: '' };
      if (argv[2] === PREPARATION_DEPENDENCY_PROBE)
        return { exitCode: 0, stdout: JSON.stringify({ fingerprint: 'd'.repeat(64) }), stderr: '' };
      if (argv[2] === OUTSIDE_WORKSPACE_WRITES_SCRIPT)
        return { exitCode: 0, stdout: 'detected\n', stderr: '' };
      return f.result;
    });
    const evidence = await prepareLaunchRepository(f.config, f.cm, 'candidate', {});
    expect(evidence).toMatchObject({
      status: 'passed',
      dependencyInputs: 'd'.repeat(64),
      outsideWorkspaceWrites: 'detected',
    });
    expect(evidence.reuse).toBeUndefined();
  });
});
