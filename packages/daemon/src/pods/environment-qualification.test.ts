import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EffectiveLaunchConfig,
  EnvironmentQualificationBindingV1,
  ExecutionRequirements,
  Pod,
} from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { ContainerExecutionMetadata } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  assertQualificationExecutionContextSupported,
  type EnvironmentQualificationInput,
  QUALIFICATION_SOURCE_PROBE,
  QUALIFICATION_TIMEOUT_MS,
  qualificationExecutionContextHash,
  qualifyExecutionEnvironment,
} from './environment-qualification.js';
import { WORKSPACE_FILE_SNAPSHOT_SCRIPT } from './workspace-file-observer.js';

const hash = 'a'.repeat(64);
const head = 'b'.repeat(40);
const base = 'c'.repeat(40);
const requirements: ExecutionRequirements = {
  version: 2,
  executables: ['jq'],
  minimumMemoryBytes: 4 * 1024 ** 3,
  minimumCpu: 1,
  platform: 'linux/amd64',
};
function fixture() {
  const cm = createMockContainerManager();
  cm.supportsStreamingExec = true;
  const metadata: ContainerExecutionMetadata = {
    imageDigest: `sha256:${hash}`,
    memoryLimitBytes: 4 * 1024 ** 3,
    cpuLimit: 2,
    networkMode: 'isolated',
  };
  cm.getResourceKey = vi.fn().mockResolvedValue('exact-docker-resource');
  cm.getExecutionMetadata = vi.fn().mockImplementation(async () => ({ ...metadata }));
  const actual = {
    platform: 'linux/amd64',
    uid: 1000,
    cwd: '/workspace/pkg',
    head,
    tree: head,
    clean: true,
    baseAncestor: true,
  };
  cm.execInContainer = vi.fn(async (_id, command) => {
    if (command[2] === QUALIFICATION_SOURCE_PROBE)
      return { exitCode: 0, stdout: JSON.stringify(actual), stderr: '' };
    if (command[2]?.includes('autopod-command-preflight-v1'))
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ executable: 'jq', available: true }]),
        stderr: '',
      };
    if (command.includes('--version')) return { exitCode: 0, stdout: 'claude 2.0.1', stderr: '' };
    return { exitCode: 0, stdout: '/usr/local/bin/claude', stderr: '' };
  });
  const profile = {
    containerMemoryGb: 4,
    buildWorkDir: 'pkg',
    buildEnv: { NODE_ENV: 'development' },
  } as PodExecutionSettings;
  const launchBody = {
    schemaVersion: 1,
    work: { contract: { executionRequirements: requirements } },
    repository: { config: { remote: 'https://github.com/org/repo' } },
    references: [],
    execution: { target: 'local' },
    resolvedEnvironment: { platform: 'linux/amd64' },
    resolvedExecution: { main: { memoryGb: 4, cpus: 2 } },
  };
  const launchConfig = {
    ...launchBody,
    digest: configurationDigest(launchBody),
  } as unknown as EffectiveLaunchConfig;
  const pod = {
    id: 'pod',
    containerId: hash,
    executionTarget: 'local',
    lifecycleGeneration: 3,
    runtime: 'claude',
    model: 'test',
    options: { validate: false },
    launchConfigDigest: launchConfig.digest,
    contract: { executionRequirements: requirements },
  } as Pod;
  const binding: EnvironmentQualificationBindingV1 = {
    version: 1,
    operationId: 'repair',
    requestHash: hash,
    podId: 'pod',
    taskId: 'task',
    executionId: 'execution',
    custodyId: 'custody',
    originalGeneration: 2,
    candidateGeneration: 3,
    originalResultHash: hash,
    reportSetHash: hash,
    requirementsHash: configurationDigest(requirements),
    originalLaunchDigest: hash,
    replacementLaunchDigest: launchConfig.digest,
    configurationHash: hash,
    sourceEpoch: hash,
    credentialEpoch: hash,
    resourceEpoch: hash,
    source: { repository: 'https://github.com/org/repo', head, tree: head, baseCommitSha: base },
    target: 'local',
    containerId: hash,
    resourceKey: 'exact-docker-resource',
    expectedImage: { kind: 'docker-image-id', digest: `sha256:${hash}` },
    platform: 'linux/amd64',
    executionContextHash: qualificationExecutionContextHash(profile),
  };
  const input: EnvironmentQualificationInput = {
    binding,
    pod,
    profile,
    launchConfig,
    containerManager: cm,
    preparationCompleted: true,
    assertCurrent: vi.fn(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
  return { input, cm, actual, metadata };
}
afterEach(() => vi.useRealTimers());

describe('actual resource environment qualification (evidence only)', () => {
  it('exercises fixed read-only source probe logic on disposable local Git bytes, not as Docker qualification', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qualification-probe-'));
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', args, { cwd: directory, encoding: 'utf8' }).trim();
    try {
      git('init', '--quiet');
      git('config', 'user.name', 'Probe fixture');
      git('config', 'user.email', 'probe@example.invalid');
      writeFileSync(join(directory, 'source.txt'), 'selected input\n');
      git('add', 'source.txt');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'selected source');
      const selected = git('rev-parse', 'HEAD');
      const script = QUALIFICATION_SOURCE_PROBE.replace(
        "const root='/workspace'",
        `const root=${JSON.stringify(directory)}`,
      );
      const probe = () =>
        JSON.parse(
          execFileSync(process.execPath, ['-e', script, selected], {
            cwd: directory,
            encoding: 'utf8',
            env: { ...process.env, GIT_DIR: '/invalid-spoofed-git-dir' },
          }),
        );
      expect(probe()).toMatchObject({
        head: selected,
        tree: git('rev-parse', 'HEAD^{tree}'),
        clean: true,
        baseAncestor: true,
        cwd: realpathSync(directory),
      });
      git('update-index', '--assume-unchanged', 'source.txt');
      writeFileSync(join(directory, 'source.txt'), 'dirty input\n');
      expect(git('status', '--porcelain')).toBe(''); // Index flags are NOT source-byte proof.
      expect(probe().clean).toBe(false);
      expect(() =>
        execFileSync(process.execPath, ['-e', QUALIFICATION_SOURCE_PROBE, 'main;whoami'], {
          stdio: 'pipe',
        }),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('checks known static context support for preview without requiring or manufacturing future-resource proof', () => {
    const { input, cm } = fixture();
    expect(() => assertQualificationExecutionContextSupported(input.profile)).not.toThrow();
    expect(cm.execInContainer).not.toHaveBeenCalled();
    for (const profile of [
      { ...input.profile, buildWorkDir: '../escape' },
      { ...input.profile, buildEnv: { NODE_OPTIONS: '--require spoof' } },
      { ...input.profile, buildEnv: { PATH: '/workspace/bin:/usr/bin' } },
    ])
      expect(() => assertQualificationExecutionContextSupported(profile)).toThrow(/unsupported/);
    expect(cm.getResourceKey).not.toHaveBeenCalled();
  });
  it('qualifies exact resource/image/context/source and declared prerequisites through normal preflight', async () => {
    const { input, cm } = fixture();
    const before = structuredClone({
      pod: input.pod,
      binding: input.binding,
      profile: input.profile,
    });
    const { evidence, provenance } = await qualifyExecutionEnvironment(input);
    expect(evidence.outcome).toBe('qualified');
    expect(evidence.expiresAt).toBe('2026-01-01T00:05:00.000Z');
    expect(evidence.bindingDigest).toBe(configurationDigest(input.binding));
    expect(evidence.observations.find((o) => o.prerequisite === 'launcher')).toMatchObject({
      launcher: 'jq',
      outcome: 'qualified',
    });
    expect(provenance?.status).toBe('checked');
    expect(cm.getResourceKey).toHaveBeenCalledTimes(2);
    for (const [, , options] of vi.mocked(cm.execInContainer).mock.calls) {
      expect(options).toMatchObject({
        cwd: '/workspace/pkg',
        env: input.profile.buildEnv,
        user: 'autopod',
        assertCurrent: expect.any(Function),
      });
    }
    expect(cm.spawn).not.toHaveBeenCalled();
    expect(cm.start).not.toHaveBeenCalled();
    expect(cm.kill).not.toHaveBeenCalled();
    expect({ pod: input.pod, binding: input.binding, profile: input.profile }).toEqual(before);
  });
  it.each([
    'resource',
    'image',
    'memory',
    'cpu',
    'platform',
    'uid',
    'cwd',
    'head',
    'tree',
    'dirty',
  ] as const)('refuses actual %s mismatch without dispatch or mutation', async (kind) => {
    const { input, cm, metadata, actual } = fixture();
    if (kind === 'resource' && cm.getResourceKey)
      vi.mocked(cm.getResourceKey).mockResolvedValue('different-resource');
    if (kind === 'image') metadata.imageDigest = `sha256:${'d'.repeat(64)}`;
    if (kind === 'memory') metadata.memoryLimitBytes = 1024;
    if (kind === 'cpu') metadata.cpuLimit = 1; // manifest permits one; selected replacement requires two.
    if (kind === 'platform') actual.platform = 'darwin/arm64';
    if (kind === 'uid') actual.uid = 0;
    if (kind === 'cwd') actual.cwd = '/tmp';
    if (kind === 'head') actual.head = base;
    if (kind === 'tree') actual.tree = base;
    if (kind === 'dirty') actual.clean = false;
    expect((await qualifyExecutionEnvironment(input)).evidence.outcome).not.toBe('qualified');
    expect(cm.spawn).not.toHaveBeenCalled();
    expect(cm.kill).not.toHaveBeenCalled();
  });
  it.each([
    'metadata',
    'streaming',
    'preparation',
    'malformed',
    'oversized',
    'exit',
    'launcher_unknown',
    'launcher_missing',
    'cli',
    'timeout',
  ] as const)('keeps %s unqualified and never replays a probe', async (kind) => {
    const { input, cm, metadata } = fixture();
    const original = cm.execInContainer;
    if (kind === 'metadata') metadata.imageDigest = null;
    if (kind === 'streaming') cm.supportsStreamingExec = undefined;
    if (kind === 'preparation') input.preparationCompleted = false;
    cm.execInContainer = vi.fn(async (...args) => {
      const command = args[1];
      if (command[2] === QUALIFICATION_SOURCE_PROBE) {
        if (kind === 'timeout') throw new Error('Lost transport');
        if (kind === 'malformed') return { exitCode: 0, stdout: '{}', stderr: '' };
        if (kind === 'oversized') return { exitCode: 0, stdout: ' '.repeat(65537), stderr: '' };
        if (kind === 'exit') return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (command[2]?.includes('autopod-command-preflight-v1') && kind.startsWith('launcher_'))
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { executable: 'jq', available: kind === 'launcher_missing' ? false : null },
          ]),
          stderr: '',
        };
      if (command.includes('--version') && kind === 'cli')
        return { exitCode: 0, stdout: 'invalid', stderr: '' };
      return original(...args);
    });
    const result = await qualifyExecutionEnvironment(input);
    expect(result.evidence.outcome).not.toBe('qualified');
    expect(
      vi
        .mocked(cm.execInContainer)
        .mock.calls.filter(([, command]) => command[2] === QUALIFICATION_SOURCE_PROBE).length,
    ).toBeLessThanOrEqual(1);
    expect(cm.kill).not.toHaveBeenCalled();
  });
  it('expires a hung resource lookup and suppresses all late preflight dispatch', async () => {
    vi.useFakeTimers();
    const { input, cm } = fixture();
    let resolve!: (key: string) => void;
    cm.getResourceKey = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const pending = qualifyExecutionEnvironment(input);
    await vi.advanceTimersByTimeAsync(QUALIFICATION_TIMEOUT_MS + 1);
    expect((await pending).evidence).toMatchObject({
      outcome: 'unknown',
      observations: [expect.anything(), expect.objectContaining({ code: 'QUALIFICATION_TIMEOUT' })],
    });
    resolve(input.binding.resourceKey);
    await Promise.resolve();
    await Promise.resolve();
    expect(cm.execInContainer).not.toHaveBeenCalled();
  });
  it.each([
    'resolve',
    'reject',
  ] as const)('propagates supersession after an awaited %s instead of publishing stale evidence', async (kind) => {
    const { input, cm } = fixture();
    let stale = false;
    input.assertCurrent = () => {
      if (stale) throw new Error('superseded');
    };
    cm.getResourceKey = vi.fn(async () => {
      stale = true;
      if (kind === 'reject') throw new Error('transport');
      return input.binding.resourceKey;
    });
    await expect(qualifyExecutionEnvironment(input)).rejects.toThrow('superseded');
    expect(cm.execInContainer).not.toHaveBeenCalled();
  });
  it.each([
    'cli',
    'metadata',
    'launchers',
    'source',
  ] as const)('fences supersession during %s observation including errors', async (stage) => {
    const { input, cm } = fixture();
    let stale = false;
    input.assertCurrent = () => {
      if (stale) throw new Error('superseded');
    };
    const original = cm.execInContainer;
    cm.execInContainer = vi.fn(async (...args) => {
      const command = args[1];
      const result = await original(...args);
      if (
        (stage === 'cli' && command.includes('--version')) ||
        (stage === 'launchers' && command[2]?.includes('autopod-command-preflight-v1')) ||
        (stage === 'source' && command[2] === QUALIFICATION_SOURCE_PROBE)
      )
        stale = true;
      return result;
    });
    if (stage === 'metadata')
      cm.getExecutionMetadata = vi.fn(async () => {
        stale = true;
        throw new Error('lost metadata');
      });
    await expect(qualifyExecutionEnvironment(input)).rejects.toThrow('superseded');
    expect(cm.kill).not.toHaveBeenCalled();
  });
  it('does not dispatch independent follow-up probes after uncertain CLI exit', async () => {
    const { input, cm } = fixture();
    cm.execInContainer = vi.fn().mockRejectedValue(new Error('lost CLI exit'));
    expect((await qualifyExecutionEnvironment(input)).evidence.outcome).toBe('unknown');
    expect(cm.execInContainer).toHaveBeenCalledTimes(1);
    expect(cm.getExecutionMetadata).not.toHaveBeenCalled();
  });
  it('invalidates a changed resource after successful probes', async () => {
    const { input, cm } = fixture();
    if (!cm.getResourceKey) throw new Error('fixture');
    vi.mocked(cm.getResourceKey)
      .mockResolvedValueOnce(input.binding.resourceKey)
      .mockResolvedValueOnce('changed');
    expect((await qualifyExecutionEnvironment(input)).evidence.outcome).toBe('unknown');
  });
  it.each([
    'manifest',
    'context',
    'generation',
    'snapshot',
    'builder',
    'preload',
  ] as const)('refuses unsupported/stale %s before effects', async (kind) => {
    const { input, cm } = fixture();
    if (kind === 'manifest') input.binding.requirementsHash = hash;
    if (kind === 'context') input.binding.executionContextHash = hash;
    if (kind === 'generation') input.binding.candidateGeneration += 1;
    if (kind === 'snapshot') input.launchConfig.task = 'changed';
    if (kind === 'builder')
      input.pod.contract = {
        ...input.pod.contract,
        executionRequirements: {
          version: 2,
          executables: ['docker'],
          requiresImageBuild: true,
        },
      } as Pod['contract'];
    if (kind === 'preload')
      input.profile.buildEnv = { NODE_OPTIONS: '--require /workspace/spoof.js' };
    expect((await qualifyExecutionEnvironment(input)).evidence.outcome).toBe('unsupported');
    expect(cm.execInContainer).not.toHaveBeenCalled();
    expect(cm.getResourceKey).not.toHaveBeenCalled();
  });
});

// Always-on real disposable-Git source logic below. This is NOT Docker/platform qualification.
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qualification-git-safety-')));
  directories.push(root);
  const cwd = join(root, 'source');
  mkdirSync(cwd);
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const gitInput = (args: string[], input?: string) =>
    execFileSync('/usr/bin/git', args, {
      cwd,
      env,
      input,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const git = (...args: string[]) => gitInput(args);
  git('init', '-q', '-b', 'base');
  git('config', 'user.name', 'Qualification Git fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'source.txt'), 'unchanged selected source\n');
  git('add', 'source.txt');
  git('commit', '-qm', 'original base');
  const base = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const script = QUALIFICATION_SOURCE_PROBE.replace(
    "const root='/workspace'",
    `const root=${JSON.stringify(cwd)}`,
  );
  const probeResult = (ancestor = base) =>
    spawnSync(process.execPath, ['-e', script, ancestor], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
    });
  const probe = (ancestor = base) => {
    const result = probeResult(ancestor);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      head: string;
      tree: string;
      clean: boolean;
      baseAncestor: boolean;
    };
  };
  const observe = () =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', WORKSPACE_FILE_SNAPSHOT_SCRIPT], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  return { root, cwd, env, git, gitInput, base, tree, probe, probeResult, observe };
}

describe('source attestation against repository-controlled Git execution and graph views', () => {
  it('never executes a clean filter across qualification, real observer baseline and repeated pre-dispatch source probe', () => {
    const f = repository();
    writeFileSync(join(f.cwd, '.gitattributes'), 'source.txt filter=reviewprobe\n');
    f.git('add', '.gitattributes');
    f.git('commit', '-qm', 'declared source attributes');
    const selected = f.git('rev-parse', 'HEAD');
    const tree = f.git('rev-parse', 'HEAD^{tree}');
    const filter = join(f.cwd, '.git/review-filter.sh');
    writeFileSync(
      filter,
      `#!/bin/sh
cat >/dev/null
count=$(cat .git/filter-count 2>/dev/null || echo 0)
count=$((count+1))
printf '%s' "$count" > .git/filter-count
if [ "$count" -ge 2 ]; then printf 'corrupted during trusted source probe\\n' > source.txt; fi
printf 'unchanged selected source\\n'
printf executed > .git/filter-ran
`,
      { mode: 0o755 },
    );
    f.git('config', 'filter.reviewprobe.clean', filter);
    // Force Git to consider conversion rather than accepting its cached stat record.
    utimesSync(join(f.cwd, 'source.txt'), new Date('2030-01-01'), new Date('2030-01-01'));
    const index = readFileSync(join(f.cwd, '.git/index'));
    const config = readFileSync(join(f.cwd, '.git/config'));
    const first = f.probe();
    expect(readFileSync(join(f.cwd, '.git/index')), 'initial source probe index').toEqual(index);
    expect(f.observe()).toMatchObject({ version: 1, complete: true });
    // Existing observer may refresh cached index stat data; do not misattribute that
    // to the source probes. Each source probe itself must leave its input index intact.
    const observerIndex = readFileSync(join(f.cwd, '.git/index'));
    const second = f.probe();
    expect({
      first,
      second,
      filterExecuted: existsSync(join(f.cwd, '.git/filter-ran')),
      count: existsSync(join(f.cwd, '.git/filter-count'))
        ? readFileSync(join(f.cwd, '.git/filter-count'), 'utf8')
        : '0',
      bytes: readFileSync(join(f.cwd, 'source.txt'), 'utf8'),
    }).toMatchObject({
      first: { head: selected, tree, clean: true, baseAncestor: true },
      second: { head: selected, tree, clean: true, baseAncestor: true },
      filterExecuted: false,
      count: '0',
      bytes: 'unchanged selected source\n',
    });
    expect(readFileSync(join(f.cwd, '.git/index'))).toEqual(observerIndex);
    expect(readFileSync(join(f.cwd, '.git/config'))).toEqual(config);
  });

  it('neutralizes clean/smudge/process/required keys including included configuration and duplicate drivers, without writing config or index', () => {
    const f = repository();
    writeFileSync(join(f.cwd, '.gitattributes'), 'source.txt filter=review.probe\n');
    f.git('add', '.gitattributes');
    f.git('commit', '-qm', 'filter attribute');
    const marker = join(f.cwd, '.git/filter-executed');
    for (const key of ['clean', 'smudge', 'process'])
      f.git('config', `filter.review.probe.${key}`, `touch ${marker}; cat`);
    f.git('config', '--add', 'filter.review.probe.clean', `touch ${marker}; cat`);
    f.git('config', 'filter.review.probe.required', 'true');
    const extra = join(f.cwd, '.git/included-filter-config');
    writeFileSync(
      extra,
      `[filter "review.probe"]\n  required = true\n  process = touch ${marker}; cat\n`,
    );
    f.git('config', 'include.path', extra);
    utimesSync(join(f.cwd, 'source.txt'), new Date('2030-01-01'), new Date('2030-01-01'));
    const index = readFileSync(join(f.cwd, '.git/index'));
    const config = readFileSync(join(f.cwd, '.git/config'));
    const included = readFileSync(extra);
    expect(f.probe().clean).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(f.cwd, '.git/index'))).toEqual(index);
    expect(readFileSync(join(f.cwd, '.git/config'))).toEqual(config);
    expect(readFileSync(extra)).toEqual(included);
    // Configured conversion must never turn real nonmatching bytes into a passing proof.
    writeFileSync(join(f.cwd, 'source.txt'), 'not the selected bytes\n');
    expect(f.probe().clean).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses ambiguous equals-bearing filter names rather than retargeting command-line overrides and executing them', () => {
    const f = repository();
    writeFileSync(join(f.cwd, '.gitattributes'), 'source.txt filter=driver=trap\n');
    f.git('add', '.gitattributes');
    f.git('commit', '-qm', 'ambiguous driver attribute');
    const config = join(f.cwd, '.git/config');
    writeFileSync(
      config,
      readFileSync(config, 'utf8') +
        '\n[filter "driver=trap"]\n  clean = touch .git/filter-ran; cat\n  required = true\n',
    );
    utimesSync(join(f.cwd, 'source.txt'), new Date('2030-01-01'), new Date('2030-01-01'));
    const result = f.probeResult();
    expect({ exit: result.status, executed: existsSync(join(f.cwd, '.git/filter-ran')) }).toEqual({
      exit: 2,
      executed: false,
    });
  });

  it('refuses missing-object promisor context without invoking its local upload-pack helper or changing source/index/config', () => {
    const f = repository();
    const remote = join(f.root, 'local-empty.git');
    f.git('init', '--bare', '-q', remote);
    const marker = join(f.cwd, '.git/upload-pack-ran');
    const helper = join(f.cwd, '.git/local-upload-pack');
    writeFileSync(helper, `#!/bin/sh\nprintf called > "${marker}"\nexit 1\n`, { mode: 0o755 });
    f.git('config', 'core.repositoryformatversion', '1');
    f.git('config', 'extensions.partialclone', 'fixture');
    f.git('config', 'remote.fixture.url', `file://${remote}`);
    f.git('config', 'remote.fixture.promisor', 'true');
    f.git('config', 'remote.fixture.uploadpack', helper);
    // Force an actual object read to need the local promisor transport if lazy fetch is allowed.
    unlinkSync(join(f.cwd, '.git/objects', f.tree.slice(0, 2), f.tree.slice(2)));
    const index = readFileSync(join(f.cwd, '.git/index'));
    const config = readFileSync(join(f.cwd, '.git/config'));
    const result = f.probeResult();
    expect({ exit: result.status, fetched: existsSync(marker) }).toEqual({
      exit: 2,
      fetched: false,
    });
    expect(result.stdout).toBe('');
    expect(readFileSync(join(f.cwd, '.git/index'))).toEqual(index);
    expect(readFileSync(join(f.cwd, '.git/config'))).toEqual(config);
    expect(readFileSync(join(f.cwd, 'source.txt'), 'utf8')).toBe('unchanged selected source\n');
    expect(QUALIFICATION_SOURCE_PROBE).toContain("env.GIT_NO_LAZY_FETCH='1'");
  });

  it('refuses an overbound filter set without truncating it into a passing executable-filter context', () => {
    const f = repository();
    const config = join(f.cwd, '.git/config');
    writeFileSync(
      config,
      readFileSync(config, 'utf8') +
        Array.from(
          { length: 257 },
          (_, i) => `\n[filter "driver${i}"]\n  clean = touch .git/filter-ran; cat\n`,
        ).join(''),
    );
    const index = readFileSync(join(f.cwd, '.git/index'));
    const result = f.probeResult();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(existsSync(join(f.cwd, '.git/filter-ran'))).toBe(false);
    expect(readFileSync(join(f.cwd, '.git/index'))).toEqual(index);
  });

  it('rejects unrelated same-tree B even when a bundled/imported replacement ref supplies fake A ancestry', () => {
    const f = repository();
    const unrelated = f.gitInput(['commit-tree', f.tree], 'unrelated selected head\n');
    f.git('switch', '-q', '-C', 'task', unrelated);
    const replacement = f.gitInput(
      ['commit-tree', f.tree, '-p', f.base],
      'replacement parents only\n',
    );
    f.git('replace', unrelated, replacement);
    const bundle = join(f.root, 'source.bundle');
    const imported = join(f.root, 'candidate.git');
    f.git('bundle', 'create', bundle, '--all');
    f.git('clone', '-q', '--bare', '--no-local', '--', bundle, imported);
    f.git(
      '-C',
      imported,
      'fetch',
      '--no-write-fetch-head',
      '--no-tags',
      '--',
      bundle,
      '+refs/*:refs/*',
    );
    expect(f.git('-C', imported, 'show-ref', `refs/replace/${unrelated}`)).toBe(
      `${replacement} refs/replace/${unrelated}`,
    );
    const truth = spawnSync(
      '/usr/bin/git',
      ['--no-replace-objects', 'merge-base', '--is-ancestor', f.base, unrelated],
      { cwd: f.cwd, env: f.env },
    );
    expect(truth.status).toBe(1);
    const result = f.probeResult();
    expect(
      result.status,
      `Source probe must not attest forged ancestry: ${result.stdout}`,
    ).not.toBe(0);
    expect(result.stdout).not.toContain('"baseAncestor":true');
  });

  it('ignores replacement objects for tree/HEAD reads too, not only the final ancestry command', () => {
    const f = repository();
    const emptyTree = f.gitInput(['hash-object', '-t', 'tree', '-w', '--stdin'], '');
    const replacement = f.gitInput(['commit-tree', emptyTree], 'replacement empty tree\n');
    f.git('replace', f.base, replacement);
    expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(emptyTree); // Adversarial default graph really differs.
    expect(f.probe(f.base)).toMatchObject({
      head: f.base,
      tree: f.tree,
      clean: true,
      baseAncestor: true,
    });
  });
});
