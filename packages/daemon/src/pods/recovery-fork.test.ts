import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AutopodError, type RecoveryForkInput, type RecoveryForkRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { deriveLaunch } from '../configuration/derive-launch.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createPassingValidationResult } from '../test-utils/mock-helpers.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { recoveryGit } from '../worktrees/recovery-fork-source.js';
import { inspectSupplementalAdoptionGit } from '../worktrees/source-adoption-git.js';
import { QUALIFICATION_SOURCE_PROBE } from './environment-qualification.js';
import { createEventRepository } from './event-repository.js';
import { createPodManager } from './pod-manager.js';
import { observeRecoveryCheckSource } from './recovery-fork-checks.js';
import {
  RecoveryForkRejectedBeforeClaim,
  RecoveryForkSelectionError,
} from './recovery-fork-rejection.js';
import { recoveryForkProcessEpoch } from './recovery-fork-repository.js';
import {
  assertFinalizationPathAvailable,
  assertFinalizationResourceAvailable,
} from './retained-finalization-repository.js';
import {
  assertSourceAvailable,
  assertSourceDeliveryAllowed,
  assertSourceResourceReleasable,
} from './source-custody-guards.js';

const exec = promisify(execFile);
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  ).stdout.trim();
async function fixture(noRequirements = false, originalHandoff?: string) {
  const f = await retainedCheckpointFixture(
    'prevalidation',
    true,
    true,
    true,
    'local',
    noRequirements
      ? undefined
      : {
          version: 2,
          executables: ['node'],
          platform: 'linux/amd64',
        },
    undefined,
    originalHandoff,
  );
  fixtures.push(f);
  await materializeCheckpointFixture(f);
  f.worktrees.inspectSourceAdoption.mockImplementation(async (cwd, branch) => {
    const source = await inspectSupplementalAdoptionGit(recoveryGit(cwd), branch);
    return { branch, commitSha: source.head, treeSha: source.tree, worktreeClean: true };
  });
  const containerId = '1'.repeat(64);
  f.ctx.podRepo.update(f.podId, {
    containerId,
    startCommitSha: f.input.checkpointHead,
    tokenBudget: 1000,
    inputTokens: 40,
    tokenTelemetryAccuracy: 'complete',
    phaseTokenUsage: {},
    validationAttempts: 1,
  });
  f.ctx.podRepo.completionJournal!.settle(f.pod(), 'Visible implementation failed during checks');
  f.ctx.podRepo.completionJournal!.mark(f.pod(), 'ready', true);
  const run = f.ctx.podRepo.taskExecutions!.beginRun(
    f.podId,
    f.pod().lifecycleGeneration,
    f.pod().finalization!.cycle,
    {
      runtime: f.pod().runtime,
      model: f.pod().model,
      providerAccountId: 'account',
      resource: { containerId, executionTarget: 'local' },
    },
  );
  f.ctx.podRepo.taskExecutions!.finishRun(run, 'completed', null);
  f.ctx.podRepo.workerRetries!.state(f.podId); // Historical import is explicit fixture setup, never GET/preview.
  f.cm.getResourceKey = vi.fn(async (id) => JSON.stringify(['docker', 'fixture', id]));
  f.cm.getStatus = vi.fn(async (id) => (id === containerId ? 'stopped' : 'running'));
  f.ctx.deps.eventRepo = createEventRepository(f.ctx.db);
  const launch = f.ctx.deps.launchConfiguration!;
  const snapshots = createLaunchSnapshotRepository(f.ctx.db, createConfigurationStore(f.ctx.db));
  launch.admitRecoveryFork = async (id, createPod, initializePod) =>
    f.ctx.podRepo.atomically!(() => {
      launch.assertRecoveryAdmissionReady!();
      return snapshots.admitRecoveryFork(id, createPod, initializePod);
    });
  launch.assertRecoveryAdmissionReady = () => {};
  launch.availableRecoveryProfiles = () => [{ id: 'profile', label: 'Development' }];
  vi.stubEnv('DATA_DIR', f.root);
  const manager = createPodManager(f.ctx.deps);
  const input: RecoveryForkInput = {
    version: 1,
    expectedGeneration: f.pod().lifecycleGeneration,
    sourceHead: f.input.checkpointHead,
    executionProfileId: '@original',
    instructions:
      'Continue the original task; investigate the failing checks and retain all prior work.',
    files: [],
    acknowledgePartialSource: true,
  };
  async function request(): Promise<RecoveryForkRequest> {
    const preview = await manager.previewRecoveryFork(f.podId, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.available).toBe(true);
    return { ...input, id: 'human-request', expectedBinding: preview.expectedBinding! };
  }
  return { ...f, manager, input, request, containerId, snapshots, launch };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function codingTransport(
  f: Awaited<ReturnType<typeof fixture>>,
  outcome: 'qualified' | 'failed' | 'unknown' = 'qualified',
) {
  const candidateId = '2'.repeat(64);
  const image = `sha256:${'a'.repeat(64)}`;
  f.launch.prepareEnvironment = vi.fn(async () => image);
  f.cm.supportsStreamingExec = true;
  f.cm.spawn = vi.fn(async () => candidateId);
  f.cm.getExecutionMetadata = vi.fn(async () => ({
    imageDigest: image,
    memoryLimitBytes: outcome === 'failed' ? 1024 : 2 * 1024 ** 3,
    cpuLimit: 1,
    networkMode: 'isolated',
  }));
  const read = f.cm.readFile.bind(f.cm);
  f.cm.readFile = vi.fn(async (id, file) =>
    file === '/autopod/recovery/handoff.json'
      ? readFile(f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.prepared!.packet, 'utf8')
      : read(id, file),
  );
  const execute = f.cm.execInContainer.bind(f.cm);
  f.cm.execInContainer = vi.fn(async (id, command, options) => {
    if (command[2] === QUALIFICATION_SOURCE_PROBE) {
      if (outcome === 'unknown') return { exitCode: 1, stdout: '', stderr: 'Unverified probe' };
      const p = f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.prepared!;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          platform: 'linux/amd64',
          uid: 1000,
          cwd: '/workspace',
          head: await git(p.worktree, 'rev-parse', 'HEAD'),
          tree: await git(p.worktree, 'rev-parse', 'HEAD^{tree}'),
          clean: (await git(p.worktree, 'status', '--porcelain')) === '',
          baseAncestor: true,
        }),
        stderr: '',
      };
    }
    if (command.includes('--version')) return { exitCode: 0, stdout: 'claude 2.0.1', stderr: '' };
    if (command[2]?.includes('autopod-command-preflight-v1')) {
      const names = JSON.parse(command[3] ?? '[]') as string[];
      return {
        exitCode: 0,
        stdout: JSON.stringify(names.map((executable) => ({ executable, available: true }))),
        stderr: '',
      };
    }
    if (command[2] === 'command -v claude')
      return { exitCode: 0, stdout: '/usr/local/bin/claude', stderr: '' };
    return execute(id, command, options);
  });
  return { candidateId, image };
}

describe('durable real recovery fork', () => {
  it('does not grant execution or source effects to another member of the same logical task', async () => {
    const f = await fixture();
    await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    f.ctx.podRepo.insert({
      id: 'unadmitted',
      executionParentPodId: f.podId,
      dispatchRepository: 'https://github.com/org/repo-a',
      profileName: 'profile',
      task: f.pod().task,
      status: 'queued',
      runtime: f.pod().runtime,
      model: f.pod().model,
      executionTarget: 'local',
      branch: 'unadmitted',
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    expect(() => assertSourceAvailable(f.ctx.db, 'unadmitted')).toThrow(
      'only its admitted independent child',
    );
    await expect(f.manager.processPod('unadmitted')).rejects.toThrow(
      'only its admitted independent child',
    );
    expect(() =>
      f.ctx.podRepo.taskExecutions!.beginRun('unadmitted', 1, 1, {
        runtime: f.pod().runtime,
        model: f.pod().model,
        providerAccountId: 'account',
      }),
    ).toThrow('only its admitted independent child');
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.worktrees.create).not.toHaveBeenCalled();
  });
  it('reopens under a fresh process epoch and observes the same uncertain operation/child without replay', async () => {
    const f = await fixture();
    const request = await f.request();
    const admitted = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
    f.ctx.podRepo.recoveryForks!.append(record.id, 'entered', {
      processEpoch: recoveryForkProcessEpoch,
    });
    const filename = path.join(f.root, 'restart.db');
    await writeFile(filename, f.ctx.db.serialize());
    const db = new Database(filename);
    try {
      vi.resetModules();
      const { createPodRepository } = await import('./pod-repository.js');
      const { createPodManager: restartedManager } = await import('./pod-manager.js');
      const { createRecoveryForkRepository, recoveryForkProcessEpoch: newEpoch } = await import(
        './recovery-fork-repository.js'
      );
      expect(newEpoch).not.toBe(recoveryForkProcessEpoch);
      const pods = createPodRepository(db);
      const manager = restartedManager({
        ...f.ctx.deps,
        podRepo: pods,
        eventRepo: createEventRepository(db),
      });
      expect(manager.getRecoveryFork(f.podId, request.id)).toMatchObject({
        state: 'unknown',
        childPodId: admitted.childPodId,
      });
      expect(await manager.createRecoveryFork(f.podId, request, f.actor)).toMatchObject({
        state: 'unknown',
        childPodId: admitted.childPodId,
      });
      await expect(manager.processPod(admitted.childPodId!)).rejects.toThrow('already entered');
      expect(createRecoveryForkRepository(db).parent(f.podId)!.facts.admitted?.childPodId).toBe(
        admitted.childPodId,
      );
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM recovery_fork_facts WHERE kind='admitted'").get(),
      ).toEqual({ n: 1 });
      expect(f.cm.spawn).not.toHaveBeenCalled();
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
  it('retains child lineage and shared accounting through normal child history retention', async () => {
    const f = await fixture();
    const request = await f.request();
    const admitted = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    const before = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    f.ctx.podRepo.delete(admitted.childPodId!);
    expect(f.manager.getRecoveryFork(f.podId, request.id).childPodId).toBe(admitted.childPodId);
    expect(f.ctx.podRepo.recoveryForks!.child(admitted.childPodId!)?.parentPodId).toBe(f.podId);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId)).toMatchObject({
      taskId: before.taskId,
      podCount: before.podCount,
      recordedTotalTokens: before.recordedTotalTokens,
      tokenBudget: before.tokenBudget,
      agentRunCount: before.agentRunCount,
    });
  });
  it('refuses retained publication custody even when no PR URL is projected on the pod', async () => {
    const f = await fixture();
    const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    f.ctx.db
      .prepare('INSERT INTO source_publication_intents VALUES(?,?,?,?,?,?,?)')
      .run('publication', 'identity', f.podId, task.taskId, 1, 'source', 'now');
    const view = await f.manager.inspectRecoveryFork(f.podId);
    expect(view.available).toBe(false);
    expect(view.blockers.join(' ')).toContain('publication/delivery/merge custody');
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it('rejects unsupported tracked credential paths rather than omitting committed code', async () => {
    const f = await fixture();
    const source = f.pod().worktreePath!;
    await writeFile(path.join(source, '.env.private'), 'fixture only');
    await git(source, 'add', '-f', '.env.private');
    await git(
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'unsupported credential path',
    );
    const view = await f.manager.inspectRecoveryFork(f.podId);
    expect(view.available).toBe(false);
    expect(view.blockers.join(' ')).toContain('Tracked credential/control/special');
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('rejects source filters without running them or preparing custody', async () => {
    const f = await fixture();
    const source = f.pod().worktreePath!;
    await git(source, 'config', 'filter.bad.clean', 'false');
    const view = await f.manager.inspectRecoveryFork(f.podId);
    expect(view.available).toBe(false);
    expect(view.blockers.join(' ')).toContain('filters');
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it('qualifies ordinary tasks without inventing custom launcher requirements', async () => {
    const f = await fixture(true);
    codingTransport(f, 'failed');
    const result = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    await f.manager.processPod(result.childPodId!);
    const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
    expect(record.facts.qualified?.evidence.binding.requirementsHash).toBe(
      configurationDigest(null),
    );
    expect(record.facts.qualified?.evidence.outcome).toBe('failed');
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.launch.read(result.childPodId!)!.work.contract).toBeUndefined();
  });
  it('refuses a selection over 50 MiB during preview, before claiming or preserving anything', async () => {
    const f = await fixture();
    for (let i = 0; i < 11; i++)
      await writeFile(
        path.join(f.pod().worktreePath!, `extra-${i}`),
        Buffer.alloc(5 * 1024 * 1024),
      );
    const view = await f.manager.inspectRecoveryFork(f.podId);
    f.input.files = view.source!.files.map(({ path, version }) => ({ path, version }));
    const preview = await f.manager.previewRecoveryFork(f.podId, f.input);
    expect(preview.available).toBe(false);
    expect(preview.blockers[0]).toContain('50 MiB');
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it('qualifies the actual normally provisioned child before a fresh lazy worker and shared retry admission', async () => {
    const f = await fixture();
    const { candidateId } = codingTransport(f);
    let observed = false;
    f.ctx.runtime.spawn = vi.fn(async function* () {
      const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
      expect(record.facts.qualified?.evidence.outcome).toBe('qualified');
      expect(record.facts.worker?.runId).toBeTruthy();
      expect(record.facts.probing?.containerId).toBe(candidateId);
      observed = true;
      yield {
        type: 'error' as const,
        timestamp: new Date().toISOString(),
        message: 'Synthetic worker failure after admission',
        fatal: true,
      };
    });
    const request = await f.request();
    const original = f.pod();
    const result = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    await f.manager.processPod(result.childPodId!);
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(observed).toBe(true);
    expect(f.pod()).toEqual(original);
    const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
    expect(record.facts.qualified?.evidence.binding.recoveryFork).toMatchObject({
      parentPodId: f.podId,
      contextHash: record.binding.contextHash,
      packetHash: record.facts.prepared!.packetHash,
    });
    const volumes = vi.mocked(f.cm.spawn).mock.calls[0]![0].volumes!;
    expect(volumes).toContainEqual({
      host: record.facts.prepared!.packet,
      container: '/autopod/recovery/handoff.json',
      readOnly: true,
    });
    expect(JSON.stringify(volumes)).not.toContain(record.facts.prepared!.snapshot);
    expect(JSON.stringify(volumes)).not.toContain(original.worktreePath);
    expect(vi.mocked(f.cm.kill).mock.calls.flat()).not.toContain(f.containerId);
  });
  it.each([
    'failed',
    'unknown',
  ] as const)('records %s qualification without coding and never probes it again', async (outcome) => {
    const f = await fixture();
    codingTransport(f, outcome);
    const request = await f.request();
    const original = f.pod();
    const result = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    await f.manager.processPod(result.childPodId!);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.qualified?.evidence.outcome).toBe(
      outcome,
    );
    expect(
      f.ctx.db.prepare('SELECT * FROM task_agent_runs WHERE pod_id=?').all(result.childPodId),
    ).toEqual([]);
    const calls = vi.mocked(f.cm.execInContainer).mock.calls.length;
    await expect(f.manager.processPod(result.childPodId!)).rejects.toThrow('already entered');
    expect(vi.mocked(f.cm.execInContainer).mock.calls.length).toBe(calls);
    expect(f.pod()).toEqual(original);
  });
  it('inspects and previews without any DB/source/provider mutation or coding receipt', async () => {
    const f = await fixture();
    const source = await readFile(path.join(f.pod().worktreePath!, '.git/config'), 'utf8');
    const changes = f.ctx.db.prepare('SELECT total_changes() AS n').get();
    const view = await f.manager.inspectRecoveryFork(f.podId);
    const preview = await f.manager.previewRecoveryFork(f.podId, f.input);
    expect(view).toMatchObject({
      available: true,
      source: { head: f.input.sourceHead },
      budget: { recordedTokens: 40, tokenBudget: 1000 },
      profiles: expect.arrayContaining([{ id: '@original', label: 'Original frozen environment' }]),
    });
    expect(preview.execution?.sameEnvironment).toBe(true);
    expect(f.ctx.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(await readFile(path.join(f.pod().worktreePath!, '.git/config'), 'utf8')).toBe(source);
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('admits one independent child in the original task without changing original or PR-fix semantics', async () => {
    const f = await fixture();
    const original = f.pod();
    const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    const request = await f.request();
    const before = f.ctx.enqueuedSessions.length;
    const result = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    expect(result).toMatchObject({ state: 'queued', parentPodId: f.podId });
    expect(result.childPodId).toBeTruthy();
    const child = f.ctx.podRepo.getOrThrow(result.childPodId!);
    expect(child).toMatchObject({
      linkedPodId: null,
      prUrl: null,
      autoApprove: false,
      startCommitSha: f.input.sourceHead,
      validationAttempts: original.validationAttempts,
      maxValidationAttempts: original.maxValidationAttempts,
      claudeSessionId: null,
      codexSessionId: null,
      piSessionId: null,
    });
    const childTask = f.ctx.podRepo.taskExecutions!.snapshot(child.id);
    expect(childTask).toMatchObject({
      taskId: task.taskId,
      rootPodId: task.rootPodId,
      tokenBudget: 1000,
      recordedTotalTokens: 40,
      agentRunCount: task.agentRunCount,
      validationExecutionCount: task.validationExecutionCount,
    });
    expect(childTask.executionId).not.toBe(task.executionId);
    expect(f.pod()).toEqual(original);
    const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
    expect(record.facts.prepared?.worktree).toBe(child.worktreePath);
    expect(await git(child.worktreePath!, 'rev-parse', 'HEAD')).toBe(request.sourceHead);
    expect(await git(child.worktreePath!, 'branch', '--show-current')).toBe(child.branch);
    expect(child.branch).not.toBe(original.branch);
    expect(f.launch.read(child.id)).toMatchObject({
      derivation: { kind: 'recovery-fork', podId: f.podId },
      workflow: { completion: 'approval' },
    });
    expect(f.ctx.enqueuedSessions.slice(before)).toEqual([child.id]);
    expect(await f.manager.createRecoveryFork(f.podId, request, f.actor)).toEqual(result);
    expect(f.ctx.enqueuedSessions.slice(before)).toEqual([child.id]);
    expect(() => f.ctx.podRepo.taskExecutions!.register(child.id, 'other')).toThrow(
      'membership already exists',
    );
    expect(() => f.ctx.podRepo.recoveryForks!.assertWorkerAllowed(child.id)).toThrow(
      'qualification',
    );
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, child.id)).toThrow(
      'source-bound fresh checks',
    );
    expect(JSON.stringify(result)).not.toContain(record.facts.prepared!.snapshot);
  });
  it('copies only chosen safe supplements and preserves private/original host evidence independently', async () => {
    const f = await fixture();
    const source = f.pod().worktreePath!;
    await writeFile(path.join(source, 'notes.txt'), 'Safe extra context');
    await writeFile(path.join(source, 'unselected.txt'), 'Keep only in original');
    await writeFile(path.join(source, '.env.private'), 'SECRET=retained');
    await symlink('/outside', path.join(source, 'alias.txt'));
    f.worktrees.inspectSourceAdoption.mockImplementation(async (cwd, branch) => ({
      branch,
      commitSha: await git(cwd, 'rev-parse', 'HEAD'),
      treeSha: await git(cwd, 'rev-parse', 'HEAD^{tree}'),
      worktreeClean: (await git(cwd, 'status', '--porcelain', '--untracked-files=no')) === '',
    }));
    const view = await f.manager.inspectRecoveryFork(f.podId);
    expect(view.blockers).toEqual([]);
    expect(view.source!.files.map((f) => f.path)).toEqual(['notes.txt', 'unselected.txt']);
    f.input.files = [view.source!.files.find((f) => f.path === 'notes.txt')!].map(
      ({ path, version }) => ({ path, version }),
    );
    const result = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    const child = f.ctx.podRepo.getOrThrow(result.childPodId!);
    const prepared = f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.prepared!;
    expect(await readFile(path.join(child.worktreePath!, 'notes.txt'), 'utf8')).toBe(
      'Safe extra context',
    );
    for (const file of ['unselected.txt', '.env.private', 'ignored-report.txt', 'alias.txt'])
      await expect(readFile(path.join(child.worktreePath!, file))).rejects.toThrow();
    expect(await readFile(path.join(prepared.snapshot, '.env.private'), 'utf8')).toBe(
      'SECRET=retained',
    );
    expect(await readFile(path.join(source, '.env.private'), 'utf8')).toBe('SECRET=retained');
    await expect(readFile(path.join(prepared.bare, 'objects/info/alternates'))).rejects.toThrow();
    await writeFile(path.join(child.worktreePath!, 'source.ts'), 'changed child');
    expect(await readFile(path.join(source, 'source.ts'), 'utf8')).toContain('preserved = true');
    expect(await git(source, 'rev-parse', 'HEAD')).toBe(f.input.sourceHead);
  });
  it('holds original resources and overlapping paths, while admitting independent child paths', async () => {
    const f = await fixture();
    const result = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    expect(() => f.ctx.podRepo.update(f.podId, { claudeSessionId: 'changed' })).toThrow(
      'retains the original',
    );
    expect(() => f.ctx.podRepo.delete(f.podId)).toThrow('retains the original');
    expect(() => assertSourceAvailable(f.ctx.db, f.podId)).toThrow('retains the original');
    expect(() => assertSourceResourceReleasable(f.ctx.db, f.containerId)).toThrow(
      'original resource',
    );
    expect(() => assertFinalizationResourceAvailable(f.ctx.db, f.containerId)).toThrow(
      'original resource',
    );
    expect(() =>
      assertFinalizationPathAvailable(f.ctx.db, path.dirname(f.pod().worktreePath!)),
    ).toThrow('source path');
    const child = f.ctx.podRepo.getOrThrow(result.childPodId!);
    expect(() => assertFinalizationPathAvailable(f.ctx.db, child.worktreePath!)).not.toThrow();
    expect(() => assertSourceAvailable(f.ctx.db, child.id)).not.toThrow();
    await expect(f.manager.killSession(f.podId)).rejects.toThrow('retains the original');
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('rejects actor/request conflicts and prevents generic derivation/admission capabilities', async () => {
    const f = await fixture();
    const request = await f.request();
    const result = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    await expect(
      f.manager.createRecoveryFork(f.podId, request, { type: 'human', userId: 'different' }),
    ).rejects.toThrow('conflicts');
    await expect(
      f.manager.createRecoveryFork(
        f.podId,
        { ...request, instructions: 'Different continuation instructions' },
        f.actor,
      ),
    ).rejects.toThrow('conflicts');
    const config = f.launch.read(result.childPodId!)!;
    const parent = f.launch.read(f.podId)!;
    expect(() => deriveLaunch(parent, { source: config.derivation!, task: parent.task })).toThrow(
      'trusted durable',
    );
    expect(() =>
      f.snapshots.admit({
        config,
        requestDigest: config.digest,
        createPod: () => {
          throw new Error('must not enter');
        },
      }),
    ).toThrow('operation-owned');
    expect(() => f.ctx.db.exec("UPDATE recovery_forks SET actor_id='other'")).toThrow('immutable');
    expect(() => f.ctx.db.exec('DELETE FROM recovery_fork_facts')).toThrow('append-only');
  });
  it.each([
    'generation',
    'context',
    'source',
    'settings',
  ] as const)('refuses stale %s before claiming/preparing', async (kind) => {
    const f = await fixture();
    const request = await f.request();
    if (kind === 'generation') f.ctx.podRepo.incrementLifecycleGeneration(f.podId);
    if (kind === 'context')
      f.ctx.deps.eventRepo!.insert({
        type: 'pod.agent_activity',
        timestamp: '2026-11-10',
        podId: f.podId,
        event: { type: 'complete', timestamp: '2026-11-10', result: 'New visible history' },
      });
    if (kind === 'source') {
      await writeFile(path.join(f.pod().worktreePath!, 'source.ts'), 'uncommitted');
    }
    if (kind === 'settings') {
      const original = f.launch.executionSettings;
      f.launch.executionSettings = (config) => ({
        ...original(config),
        buildEnv: { NEW: 'value' },
      });
    }
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toThrow();
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    expect(f.ctx.db.prepare('SELECT * FROM recovery_fork_facts').all()).toEqual([]);
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('requires exact stopped original resource and positive settlement, budget and retry evidence', async () => {
    const f = await fixture();
    f.cm.getStatus = vi.fn(async () => 'unknown');
    expect((await f.manager.inspectRecoveryFork(f.podId)).available).toBe(false);
    f.cm.getStatus = vi.fn(async () => 'stopped');
    f.ctx.podRepo.update(f.podId, { inputTokens: 1000 });
    expect((await f.manager.inspectRecoveryFork(f.podId)).budget?.status).toBe('exhausted');
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it('persists failed preparation ownership and replays observations without creating a child', async () => {
    const f = await fixture();
    const request = await f.request();
    const original = f.launch.admitRecoveryFork!;
    f.launch.admitRecoveryFork = async () => {
      throw new Error('lost admission transport');
    };
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toThrow(
      'lost admission',
    );
    expect(f.manager.getRecoveryFork(f.podId, request.id)).toMatchObject({
      state: 'unknown',
      childPodId: null,
    });
    f.launch.admitRecoveryFork = original;
    const replay = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    expect(replay).toMatchObject({ state: 'unknown', childPodId: null });
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.prepared).toBeTruthy();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('never substitutes remote source or re-enters uncertain child provisioning', async () => {
    const f = await fixture();
    const request = await f.request();
    const result = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    const child = f.ctx.podRepo.getOrThrow(result.childPodId!);
    await rm(child.worktreePath!, { recursive: true });
    await f.manager.processPod(child.id);
    expect(f.worktrees.create).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.manager.getRecoveryFork(f.podId, request.id)).toMatchObject({
      state: 'unknown',
      childPodId: child.id,
    });
    await expect(f.manager.processPod(child.id)).rejects.toThrow('already entered');
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.entered?.processEpoch).toBe(
      recoveryForkProcessEpoch,
    );
  });
  it('redacts bounded visible context while omitting reasoning, tool and credential payloads', async () => {
    const f = await fixture();
    const events = f.ctx.deps.eventRepo!;
    for (const event of [
      { type: 'reasoning' as const, timestamp: 'now', text: 'private reasoning' },
      {
        type: 'tool_use' as const,
        timestamp: 'now',
        tool: 'credential',
        input: { secret: 'private tool' },
      },
      {
        type: 'complete' as const,
        timestamp: 'now',
        result: 'Visible result password=do-not-carry',
      },
    ])
      events.insert({ type: 'pod.agent_activity', podId: f.podId, timestamp: 'now', event });
    const view = await f.manager.inspectRecoveryFork(f.podId);
    const context = JSON.stringify(view.context);
    expect(context).toContain('Visible result');
    for (const secret of ['private reasoning', 'private tool', 'do-not-carry'])
      expect(context).not.toContain(secret);
    expect(context).toContain('not guaranteed secret-free');
  });
});

describe('reviewed recovery boundaries', () => {
  it('produces exact rejection proof for stale preview before claim, never from a missing operation GET', async () => {
    const f = await fixture();
    const request = { ...(await f.request()), expectedBinding: '0'.repeat(64) };
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toMatchObject({
      code: 'RECOVERY_FORK_REJECTED_BEFORE_CLAIM',
      parentPodId: f.podId,
      requestId: request.id,
      expectedBinding: request.expectedBinding,
      noOperationCreated: true,
      reasonCode: 'RECOVERY_FORK_SELECTION_STALE',
      statusCode: 409,
    });
    expect(() => f.manager.getRecoveryFork(f.podId, request.id)).toThrow('not found');
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it.each([
    'unknown',
    '404',
    'generic-policy-code',
  ] as const)('keeps %s read-only infrastructure errors unproved', async (kind) => {
    const f = await fixture();
    const request = await f.request();
    const error =
      kind === '404'
        ? new AutopodError('Not found', 'NOT_FOUND', 404)
        : kind === 'generic-policy-code'
          ? new AutopodError('Unknown policy transport', 'RECOVERY_FORK_BLOCKED', 409)
          : new Error('unknown read outcome');
    f.cm.getResourceKey = vi.fn(async () => {
      throw error;
    });
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toBe(error);
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it('keeps an explicitly unknown resource observation unproved', async () => {
    const f = await fixture();
    const request = await f.request();
    f.cm.getStatus = vi.fn(async () => 'unknown' as const);
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toMatchObject({
      code: 'RECOVERY_FORK_RESOURCE_UNKNOWN',
      statusCode: 503,
    });
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('keeps a missing Git ancestry object unproved instead of calling every Git failure non-ancestry', async () => {
    const f = await fixture();
    const request = await f.request();
    f.ctx.podRepo.update(f.podId, { startCommitSha: 'f'.repeat(40) });
    try {
      await f.manager.createRecoveryFork(f.podId, request, f.actor);
      throw new Error('Missing ancestry must reject');
    } catch (error) {
      expect(error).not.toBeInstanceOf(RecoveryForkRejectedBeforeClaim);
      expect(error).toMatchObject({ code: 128 });
    }
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('never proves a claim-attempt exception, even when rollback leaves no row', async () => {
    const f = await fixture();
    const request = await f.request();
    const error = new AutopodError('Claim uncertain', 'RECOVERY_FORK_BLOCKED', 409);
    vi.spyOn(f.ctx.podRepo.recoveryForks!, 'claim').mockImplementation(() => {
      throw error;
    });
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toBe(error);
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it('never grants discard proof for an existing replay, actor conflict or post-claim failure', async () => {
    const f = await fixture();
    const request = await f.request();
    const error = new AutopodError('Admission failed', 'RECOVERY_FORK_BLOCKED', 409);
    f.launch.admitRecoveryFork = vi.fn(async () => {
      throw error;
    });
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toBe(error);
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeTruthy();
    f.launch.assertRecoveryAdmissionReady = () => {
      throw new Error('closed');
    };
    const replay = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    expect(replay).toMatchObject({ state: 'failed', childPodId: null });
    expect(replay).not.toHaveProperty('noOperationCreated');
    try {
      await f.manager.createRecoveryFork(f.podId, request, { type: 'human', userId: 'other' });
      throw new Error('Conflict must reject');
    } catch (conflict) {
      expect(conflict).toMatchObject({ code: 'RECOVERY_FORK_REQUEST_CONFLICT' });
      expect(conflict).not.toBeInstanceOf(RecoveryForkRejectedBeforeClaim);
    }
  });
  it('checks cutover at eligibility and retains exact replay with the gate closed', async () => {
    const f = await fixture();
    const request = await f.request();
    const gate = () => {
      throw new RecoveryForkSelectionError('Cutover closed', 'CONFIG_CUTOVER_REQUIRED');
    };
    f.launch.assertRecoveryAdmissionReady = gate;
    expect((await f.manager.inspectRecoveryFork(f.podId)).available).toBe(false);
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toMatchObject({
      code: 'RECOVERY_FORK_REJECTED_BEFORE_CLAIM',
      reasonCode: 'CONFIG_CUTOVER_REQUIRED',
    });
    f.launch.assertRecoveryAdmissionReady = () => {};
    const operation = await f.manager.createRecoveryFork(f.podId, request, f.actor);
    f.launch.assertRecoveryAdmissionReady = gate;
    expect(await f.manager.createRecoveryFork(f.podId, request, f.actor)).toEqual(operation);
    expect(f.manager.getRecoveryFork(f.podId, request.id)).toEqual(operation);
    expect((await f.manager.inspectRecoveryFork(f.podId)).operation).toEqual(operation);
  });
  it('does not admit or enqueue a child if cutover closes after source preparation', async () => {
    const f = await fixture();
    const request = await f.request();
    const admit = f.launch.admitRecoveryFork!;
    f.launch.admitRecoveryFork = async (...args) => {
      f.launch.assertRecoveryAdmissionReady = () => {
        throw new RecoveryForkSelectionError('Cutover closed', 'CONFIG_CUTOVER_REQUIRED');
      };
      return admit(...args);
    };
    const before = f.ctx.enqueuedSessions.length;
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toMatchObject({
      code: 'CONFIG_CUTOVER_REQUIRED',
    });
    expect(f.manager.getRecoveryFork(f.podId, request.id).childPodId).toBeNull();
    expect(f.ctx.enqueuedSessions.length).toBe(before);
    expect(f.ctx.db.prepare('SELECT COUNT(*) AS n FROM pods').get()).toEqual({ n: 1 });
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('refuses a forged replacement graph before claim without modifying original metadata', async () => {
    const f = await fixture();
    const request = await f.request();
    const source = f.pod().worktreePath!;
    const original = request.sourceHead;
    await writeFile(path.join(source, 'source.ts'), 'export const forged = true;\n');
    await git(source, 'add', 'source.ts');
    await git(
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'forged graph',
    );
    const replacement = await git(source, 'rev-parse', 'HEAD');
    await git(source, 'reset', '--hard', original);
    await git(source, 'replace', original, replacement);
    expect(await git(source, 'show', 'HEAD:source.ts')).toContain('forged');
    const config = await readFile(path.join(source, '.git/config'), 'utf8');
    const view = await f.manager.inspectRecoveryFork(f.podId);
    expect(view.available).toBe(false);
    expect(view.blockers.join(' ')).toContain('Replacement refs');
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toMatchObject({
      code: 'RECOVERY_FORK_REJECTED_BEFORE_CLAIM',
    });
    expect(await git(source, 'show', 'HEAD:source.ts')).toContain('forged');
    expect(await readFile(path.join(source, '.git/config'), 'utf8')).toBe(config);
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it.each([
    '--assume-unchanged',
    '--skip-worktree',
    'sparse-index',
  ] as const)('refuses hidden tracked changes: %s', async (flag) => {
    const f = await fixture();
    const request = await f.request();
    const source = f.pod().worktreePath!;
    if (flag === 'sparse-index') await git(source, 'config', 'index.sparse', 'true');
    else {
      await git(source, 'update-index', flag, 'source.ts');
      await writeFile(path.join(source, 'source.ts'), 'hidden edit');
      expect(await git(source, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    }
    expect((await f.manager.inspectRecoveryFork(f.podId)).available).toBe(false);
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toThrow();
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('preserves original frozen handoff separately from the new human continuation', async () => {
    const original = 'Do not edit the database schema. Keep all historical API constraints.';
    const f = await fixture(false, original);
    await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
    const packet = JSON.parse(await readFile(record.facts.prepared!.packet, 'utf8'));
    expect(packet.originalFrozenHandoffInstructions).toBe(original);
    expect(packet.humanContinuationInstructions).toBe(f.input.instructions);
    expect(record.binding.originalLaunch.work.handoffInstructions).toBe(original);
    expect(f.launch.read(record.facts.admitted!.childPodId)!.work.handoffInstructions).toContain(
      '/autopod/recovery/handoff.json',
    );
  });
  it('explicitly refuses pointer-only handoff chains without reading a same-path packet', async () => {
    const f = await fixture(
      false,
      'Read /autopod/recovery/handoff.json from the earlier recovery.',
    );
    const view = await f.manager.inspectRecoveryFork(f.podId);
    expect(view.blockers.join(' ')).toContain('Chained recovery');
    expect(view.available).toBe(false);
    expect(f.cm.readFile).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
  it('preserves PR-fix counters and limits without importing delivery links', async () => {
    const f = await fixture();
    f.ctx.podRepo.update(f.podId, { prFixAttempts: 2, maxPrFixAttempts: 2 });
    const result = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    expect(f.ctx.podRepo.getOrThrow(result.childPodId!)).toMatchObject({
      prFixAttempts: 2,
      maxPrFixAttempts: 2,
      linkedPodId: null,
      fixPodId: null,
      prUrl: null,
    });
  });
});

/** Execute the actual population/reconstruction/clean and qualification scripts in
 * an isolated temp Git candidate. Only container transport/OS identity is mocked. */
async function filesystemCodingTransport(
  f: Awaited<ReturnType<typeof fixture>>,
  corrupt: false | 'changed' | 'missing' = false,
) {
  codingTransport(f);
  const candidate = path.join(f.root, 'actual-candidate');
  await mkdir(candidate);
  const previous = f.cm.execInContainer.bind(f.cm);
  const write = f.cm.writeFile.bind(f.cm);
  let cleaned = false;
  f.cm.writeFile = vi.fn(async (id, file, bytes) => {
    if (file === '/workspace/.git/info/exclude')
      await writeFile(path.join(candidate, '.git/info/exclude'), bytes);
    else await write(id, file, bytes);
  });
  f.cm.execInContainer = vi.fn(async (id, command, options) => {
    const prepared = f.ctx.podRepo.recoveryForks!.parent(f.podId)?.facts.prepared;
    if (command[2] === QUALIFICATION_SOURCE_PROBE && prepared) {
      const script = QUALIFICATION_SOURCE_PROBE.replace(
        "const root='/workspace'",
        `const root=${JSON.stringify(candidate)}`,
      ).replace(
        "verify('/autopod/recovery','handoff.json',recovery.packetHash)",
        `verify(${JSON.stringify(path.dirname(prepared.packet))},'handoff.json',recovery.packetHash)`,
      );
      try {
        const result = await exec('node', ['-e', script, ...command.slice(3)], { cwd: candidate });
        const observed = JSON.parse(result.stdout);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ...observed,
            platform: 'linux/amd64',
            uid: 1000,
            cwd: '/workspace',
          }),
          stderr: '',
        };
      } catch {
        return { exitCode: 1, stdout: '', stderr: 'Candidate bytes failed actual probe' };
      }
    }
    if (prepared && !cleaned && command.some((arg) => arg.includes('/workspace'))) {
      const [program, ...args] = command.map((arg) =>
        arg.replaceAll('/mnt/worktree', prepared.worktree).replaceAll('/workspace', candidate),
      );
      try {
        const result = await exec(program!, args, {
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        });
        if (command.includes('clean')) {
          cleaned = true;
          if (corrupt === 'changed')
            await writeFile(path.join(candidate, prepared.files[0]!.path), 'tampered');
          if (corrupt === 'missing') await rm(path.join(candidate, prepared.files[0]!.path));
        }
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof e.code === 'number' ? e.code : 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? 'Temp Git command failed',
        };
      }
    }
    return previous(id, command, options);
  });
  return { candidate, wasCleaned: () => cleaned };
}

async function checkedChildFixture() {
  const f = await fixture();
  codingTransport(f);
  f.ctx.runtime.spawn = vi.fn(async function* () {
    yield {
      type: 'complete' as const,
      timestamp: new Date().toISOString(),
      result: 'Implementation complete',
    };
  });
  f.ctx.validationEngine.validate = vi.fn(async (config) => ({
    ...createPassingValidationResult(config.podId, config.attempt),
    taskReview: {
      status: 'pass' as const,
      reasoning: 'Independent review passed',
      issues: [],
      model: 'claude-opus-4-6',
      screenshots: [],
      diff: 'fixture',
    },
  }));
  const operation = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
  await f.manager.processPod(operation.childPodId!);
  const child = () => f.ctx.podRepo.getOrThrow(operation.childPodId!);
  expect(child().status).toBe('validated');
  return { ...f, child };
}

describe('actual recovery candidate bytes', () => {
  it('keeps exact daemon evidence outputs clean through actual reconstruction and passing validation', async () => {
    const f = await fixture();
    const { candidate } = await filesystemCodingTransport(f);
    f.ctx.runtime.spawn = vi.fn(async function* () {
      yield { type: 'complete' as const, timestamp: new Date().toISOString(), result: 'Done' };
    });
    f.ctx.validationEngine.validate = vi.fn(async (config) => {
      for (const file of ['.autopod/evidence/facts.json', '.autopod/screenshots/page.png']) {
        await mkdir(path.dirname(path.join(candidate, file)), { recursive: true });
        await writeFile(path.join(candidate, file), 'Daemon-generated validation evidence');
      }
      return {
        ...createPassingValidationResult(config.podId, config.attempt),
        taskReview: {
          status: 'pass' as const,
          reasoning: 'Independent review',
          issues: [],
          model: 'claude-opus-4-6',
          screenshots: [],
          diff: 'fixture',
        },
      };
    });
    const operation = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    await f.manager.processPod(operation.childPodId!);
    const child = f.ctx.podRepo.getOrThrow(operation.childPodId!);
    expect({ status: child.status, reason: child.failureReason }).toEqual({
      status: 'validated',
      reason: null,
    });
    expect(await git(candidate, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(candidate, '.autopod/evidence/facts.json'), 'utf8')).toContain(
      'Daemon-generated',
    );
    expect(
      f.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM recovery_fork_delivery_evidence WHERE kind='checks'")
        .get(),
    ).toEqual({ n: 1 });
  });
  it('allows committed supplemental edits after coding, while uncommitted edits and initial tampering remain fenced', async () => {
    const f = await fixture();
    await writeFile(path.join(f.pod().worktreePath!, 'new-code.ts'), 'export const value = 1;\n');
    const view = await f.manager.inspectRecoveryFork(f.podId);
    f.input.files = view.source!.files.map(({ path, version }) => ({ path, version }));
    const { candidate } = await filesystemCodingTransport(f);
    const operation = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    await f.manager.processPod(operation.childPodId!);
    const prepared = f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.prepared!;
    const child = f.ctx.podRepo.getOrThrow(operation.childPodId!);
    await writeFile(path.join(candidate, 'new-code.ts'), 'export const value = 2;\n');
    await expect(observeRecoveryCheckSource(f.cm, child, prepared)).rejects.toThrow(
      'verified clean actual source',
    );
    await git(candidate, '--literal-pathspecs', 'add', '-f', '--', 'new-code.ts');
    await git(
      candidate,
      '-c',
      'user.name=Recovery test',
      '-c',
      'user.email=recovery@example.test',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'Continue imported code',
    );
    const evolved = await observeRecoveryCheckSource(f.cm, child, prepared);
    expect(evolved.head).toBe(await git(candidate, 'rev-parse', 'HEAD'));
    expect(evolved.head).not.toBe(prepared.head);
    expect(evolved.tree).toBe(await git(candidate, 'rev-parse', 'HEAD^{tree}'));
    expect(f.ctx.runtime.spawn).toHaveBeenCalledOnce();
  });
  it.each([
    false,
    'changed',
    'missing',
  ] as const)('reconstructs Git, protects exact extras, cleans ordinary debris and fences corrupt=%s before coding', async (corrupt) => {
    const f = await fixture();
    const names = [
      'notes.txt',
      '#literal!.txt',
      '!negated.txt',
      'brackets[ab]*?.txt',
      ' leading and trailing ',
      'nested/a[b]!.txt',
    ];
    for (const name of names) {
      await mkdir(path.dirname(path.join(f.pod().worktreePath!, name)), { recursive: true });
      await writeFile(path.join(f.pod().worktreePath!, name), `Selected ${name}`);
    }
    const view = await f.manager.inspectRecoveryFork(f.podId);
    f.input.files = view.source!.files.map(({ path, version }) => ({ path, version }));
    expect(f.input.files).toHaveLength(names.length);
    const { candidate, wasCleaned } = await filesystemCodingTransport(f, corrupt);
    await writeFile(path.join(candidate, 'old-image-file.txt'), 'Remove old image debris');
    await writeFile(
      path.join(candidate, 'bracketsaX.txt'),
      'Literal exclusion must not protect a wildcard match',
    );
    const operation = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    await f.manager.processPod(operation.childPodId!);
    expect(wasCleaned()).toBe(true);
    await expect(readFile(path.join(candidate, 'old-image-file.txt'))).rejects.toThrow();
    await expect(readFile(path.join(candidate, 'bracketsaX.txt'))).rejects.toThrow();
    if (corrupt) {
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
      const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
      expect(record.facts.qualified?.evidence.outcome).not.toBe('qualified');
      expect(record.facts.worker).toBeUndefined();
    } else {
      for (const name of names)
        expect(await readFile(path.join(candidate, name), 'utf8')).toBe(`Selected ${name}`);
      expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.qualified?.evidence.outcome).toBe(
        'qualified',
      );
      expect(f.ctx.runtime.spawn).toHaveBeenCalledOnce();
      expect(await git(candidate, 'status', '--porcelain')).toBe('');
    }
  });
  it('lets the first authenticated human approval enter the actual workflow after fresh source-bound checks', async () => {
    const f = await fixture();
    codingTransport(f);
    f.ctx.runtime.spawn = vi.fn(async function* () {
      yield {
        type: 'complete' as const,
        timestamp: new Date().toISOString(),
        result: 'Implementation complete',
      };
    });
    f.ctx.validationEngine.validate = vi.fn(async (config) => ({
      ...createPassingValidationResult(config.podId, config.attempt),
      taskReview: {
        status: 'pass' as const,
        reasoning: 'Independent fixture review passed',
        issues: [],
        model: 'claude-opus-4-6',
        screenshots: [],
        diff: 'fixture',
      },
    }));
    const operation = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    await f.manager.processPod(operation.childPodId!);
    const child = () => f.ctx.podRepo.getOrThrow(operation.childPodId!);
    expect({ status: child().status, reason: child().failureReason }).toEqual({
      status: 'validated',
      reason: null,
    });
    expect(child().readinessReview?.approval).toBeFalsy();
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, child().id)).toThrow('human approval');
    await expect(
      f.manager.approveSession(child().id, { actor: { type: 'automation', id: 'auto' } }),
    ).rejects.toThrow('human approval');
    const publication = async (
      cwd: string,
      branch: string,
      options?: import('../interfaces/worktree-manager.js').BranchPublicationOptions,
    ) => {
      const commitSha = await git(cwd, 'rev-parse', 'HEAD');
      const treeSha = await git(cwd, 'rev-parse', 'HEAD^{tree}');
      const receipt = {
        branch,
        repository: options?.expectedRepository ?? 'https://github.com/org/repo-a',
        commitSha,
        treeSha,
        remoteRef: `refs/heads/${branch}`,
        observedRemoteCommitSha: commitSha,
        worktreeClean: true as const,
        observedAt: new Date().toISOString(),
      };
      options?.onPrepared?.(receipt);
      return receipt;
    };
    f.worktrees.pushBranch = vi.fn(publication);
    f.worktrees.mergeBranch = vi.fn(async (config) =>
      publication(config.worktreePath, config.targetBranch, config),
    );
    await f.manager.approveSession(child().id, { actor: f.actor });
    expect(child().readinessReview?.approval?.actor).toEqual(f.actor);
    expect(
      f.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM recovery_fork_delivery_evidence WHERE kind='approval'")
        .get(),
    ).toEqual({ n: 1 });
  });
});

describe('recovery approval custody', () => {
  it.each([
    'dirty-bytes',
    'new-commit',
    'checks',
    'generation',
    'readiness-only',
  ] as const)('refuses %s without recording human authority or publishing', async (change) => {
    const f = await checkedChildFixture();
    const child = f.child();
    if (change === 'dirty-bytes' || change === 'new-commit') {
      await writeFile(path.join(child.worktreePath!, 'source.ts'), 'Changed after fresh checks');
      if (change === 'new-commit') {
        await git(child.worktreePath!, 'add', 'source.ts');
        await git(
          child.worktreePath!,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'unchecked source',
        );
      }
    }
    if (change === 'checks')
      f.ctx.podRepo.update(child.id, {
        lastValidationResult: { ...child.lastValidationResult!, timestamp: 'changed-result' },
      });
    if (change === 'generation') f.ctx.podRepo.incrementLifecycleGeneration(child.id);
    if (change === 'readiness-only') {
      f.ctx.podRepo.update(child.id, {
        readinessReview: {
          ...child.readinessReview!,
          approval: {
            actor: f.actor,
            approvedAt: 'old',
            approvedBy: 'old',
            scope: 'pod',
            statusAtApproval: 'ready',
          },
        },
      });
      expect(() => assertSourceDeliveryAllowed(f.ctx.db, child.id)).toThrow('human approval');
      // A mutable/inherited readiness projection is not publication authority.
      const record = f.ctx.podRepo.recoveryForks!.child(child.id)!;
      expect(() =>
        f.ctx.podRepo.sourcePublications!.admit(child, {
          repository: record.binding.source.repository,
          branch: child.branch,
          remoteRef: `refs/heads/${child.branch}`,
          commitSha: record.facts.prepared!.head,
          treeSha: record.facts.prepared!.tree,
          worktreeClean: true,
        }),
      ).toThrow('human approval');
      return;
    }
    await expect(f.manager.approveSession(child.id, { actor: f.actor })).rejects.toThrow();
    expect(
      f.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM recovery_fork_delivery_evidence WHERE kind='approval'")
        .get(),
    ).toEqual({ n: 0 });
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    expect(f.worktrees.mergeBranch).not.toHaveBeenCalled();
  });
  it('settles actual checks accounting and refuses changed source after the engine returns', async () => {
    const f = await fixture();
    codingTransport(f);
    f.ctx.runtime.spawn = vi.fn(async function* () {
      yield { type: 'complete' as const, timestamp: new Date().toISOString(), result: 'Complete' };
    });
    f.ctx.validationEngine.validate = vi.fn(async (config) => {
      const child = f.ctx.podRepo.getOrThrow(config.podId);
      await writeFile(path.join(child.worktreePath!, 'source.ts'), 'Changed inside checks');
      return {
        ...createPassingValidationResult(config.podId, config.attempt),
        taskReview: {
          status: 'pass' as const,
          reasoning: 'Fixture review',
          issues: [],
          model: 'reviewer',
          screenshots: [],
          diff: 'fixture',
        },
      };
    });
    const result = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    await f.manager.processPod(result.childPodId!);
    expect(f.ctx.podRepo.getOrThrow(result.childPodId!).lastValidationResult?.overall).toBe('fail');
    expect(
      f.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM recovery_fork_delivery_evidence WHERE kind='checks'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      f.ctx.db
        .prepare("SELECT outcome FROM task_retry_attempts WHERE pod_id=? AND stage='validation'")
        .get(result.childPodId),
    ).toEqual({ outcome: 'nonretryable' });
  });
});

describe('rejection proof source ownership', () => {
  it('does not prove absence when another delivery ledger owns the selected task source', async () => {
    const f = await fixture();
    const request = await f.request();
    const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    f.ctx.db
      .prepare('INSERT INTO source_publication_intents VALUES(?,?,?,?,?,?,?)')
      .run('publication-after-preview', 'identity', f.podId, task.taskId, 1, 'source', 'now');
    try {
      await f.manager.createRecoveryFork(f.podId, request, f.actor);
      throw new Error('Source owner must block');
    } catch (error) {
      expect(error).not.toBeInstanceOf(RecoveryForkRejectedBeforeClaim);
      expect(error).not.toHaveProperty('noOperationCreated');
    }
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
  });
});

describe('final pre-claim source check', () => {
  it('refuses replacement metadata introduced while read-only capability resolution was awaited', async () => {
    const f = await fixture();
    const request = await f.request();
    const source = f.pod().worktreePath!;
    f.launch.assertCurrentCapabilities = vi.fn(async () => {
      await git(source, 'update-ref', `refs/replace/${request.sourceHead}`, request.sourceHead);
    });
    await expect(f.manager.createRecoveryFork(f.podId, request, f.actor)).rejects.toMatchObject({
      code: 'RECOVERY_FORK_REJECTED_BEFORE_CLAIM',
    });
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    expect(await git(source, 'for-each-ref', '--format=%(refname)', 'refs/replace/')).toContain(
      request.sourceHead,
    );
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
});
