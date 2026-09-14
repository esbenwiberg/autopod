import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SourceCandidateReceipt } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { fixture, resign } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import {
  ManagedSupervisedValidation,
  type ManagedValidationBoundary,
} from './validation-runtime.js';
import type { ManagedValidationConfig } from './validation.js';

async function setup() {
  const f = fixture();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-validation-runtime-')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('commit', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const request = structuredClone(f.request);
  request.task.kind = 'implementation';
  request.outputs.source = {
    mode: 'branch',
    repository: 'fixture-repo',
    remote: 'fixture-remote',
    head: 'dispatcher/workers/one',
    base: 'main',
  };
  const repository = request.effectiveGrant.scope.repositories[0];
  if (!repository) throw new Error('missing-test-repository');
  repository.access = 'write';
  request.effectiveGrant.scope.allowedEffects.push('test.run');
  const configuration: ManagedValidationConfig = {
    phases: [{ phase: 'build', command: 'npm run build', timeoutMs: 30000 }],
    workingDirectory: '',
  };
  request.validation.autopod = {
    mode: 'deterministic',
    configurationDigest: digest(configuration),
  };
  resign(request);
  const candidate: SourceCandidateReceipt = {
    schemaVersion: 1,
    candidateId: 'candidate-one',
    podId: 'managed-one',
    dispatcherAttemptId: request.dispatcherAttemptId,
    executionSpecDigest: request.executionSpecDigest,
    repository: request.outputs.source.repository,
    remote: request.outputs.source.remote,
    head: request.outputs.source.head,
    base: request.outputs.source.base,
    expectedOldCommit: '0'.repeat(40),
    newCommit: commit,
    evidenceDigest: digest({ evidence: true }),
    candidateDigest: digest({ candidate: true }),
  };
  let observations = 0;
  let launch = '';
  const ensure = vi.fn(async (config: ContainerSpawnConfig) => {
    config.onCreated?.('validation-ref');
    return 'validation-ref';
  });
  const exec = vi.fn(async (_ref: string, command: string[]) => {
    if (command[3]?.endsWith('/launch.json')) launch = command[4] ?? '';
    if (command[3]?.endsWith('/execution.json')) {
      observations++;
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          specDigest: request.executionSpecDigest,
          configurationDigest: request.validation.autopod?.configurationDigest,
          candidateDigest: candidate.candidateDigest,
          newCommit: candidate.newCommit,
          state: observations === 1 ? 'running' : 'stopped',
          observedExit: observations !== 1,
          startedAt: 100,
          completedAt: observations === 1 ? 0 : 101,
          phases: [
            {
              phase: 'build',
              status: observations === 1 ? 'running' : 'passed',
              durationMs: observations === 1 ? 0 : 12,
            },
          ],
          result: observations === 1 ? 'running' : 'passed',
          reason: '',
        }),
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const manager = {
    ensureManagedContainer: ensure,
    execInContainer: exec,
    getStatus: vi.fn(async () => 'running' as const),
    kill: vi.fn(async () => {}),
  } as unknown as ContainerManager;
  const boundary: ManagedValidationBoundary = {
    route: request.route,
    manager,
    image: `registry.example/validation@sha256:${'a'.repeat(64)}`,
    configuration,
    sourceWorkspace: () => root,
    network: () => ({ firewallScript: 'deny', networkName: 'validation-network' }),
  };
  return {
    f,
    root,
    request,
    candidate,
    configuration,
    manager,
    ensure,
    exec,
    launch: () => JSON.parse(launch) as Record<string, unknown>,
    port: new ManagedSupervisedValidation([boundary], 'fixture-supervisor'),
  };
}

it('binds a dedicated resource to the exact candidate and reports phase progress', async () => {
  const x = await setup();
  const started = vi.fn();
  const completed = vi.fn();
  const checkpoint = vi.fn();
  try {
    await expect(
      x.port.run(
        x.request,
        x.candidate,
        4102444800,
        { onPhaseStarted: started, onPhaseCompleted: completed },
        new AbortController().signal,
        checkpoint,
      ),
    ).resolves.toEqual({ overall: 'pass' });
    expect(x.ensure).toHaveBeenCalledOnce();
    expect(x.ensure.mock.calls[0]?.[0]).toMatchObject({
      podId: 'managed-validation-one',
      image: `registry.example/validation@sha256:${'a'.repeat(64)}`,
      env: {},
      exposeHostGateway: false,
      networkPolicyMode: 'deny-all',
      volumes: [{ host: x.root, container: '/repositories/fixture-repo', readOnly: true }],
    });
    expect(checkpoint).toHaveBeenCalledWith('validation-ref');
    expect(x.launch()).toMatchObject({
      specDigest: x.request.executionSpecDigest,
      configurationDigest: x.request.validation.autopod?.configurationDigest,
      candidateDigest: x.candidate.candidateDigest,
      newCommit: x.candidate.newCommit,
      expiresAt: 4102444800,
    });
    expect(started).toHaveBeenCalledWith('build');
    expect(completed).toHaveBeenCalledWith('build', 'pass', { duration: 12 });
    await x.port.cleanup(x.request, 'validation-ref');
    expect(x.manager.kill).toHaveBeenCalledWith('validation-ref');
  } finally {
    x.f.close();
    await rm(x.root, { recursive: true, force: true });
  }
});

it('rejects a stale configuration digest before allocation', async () => {
  const x = await setup();
  try {
    x.request.validation.autopod = {
      mode: 'deterministic',
      configurationDigest: digest({ different: true }),
    };
    expect(() => x.port.preflight(x.request)).toThrow('managed-validation-enforcement-unavailable');
    expect(x.ensure).not.toHaveBeenCalled();
  } finally {
    x.f.close();
    await rm(x.root, { recursive: true, force: true });
  }
});
