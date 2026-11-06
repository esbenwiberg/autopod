import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  type EnvironmentQualificationInput,
  QUALIFICATION_SOURCE_PROBE,
  QUALIFICATION_TIMEOUT_MS,
  qualificationExecutionContextHash,
  qualifyExecutionEnvironment,
} from './environment-qualification.js';

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
