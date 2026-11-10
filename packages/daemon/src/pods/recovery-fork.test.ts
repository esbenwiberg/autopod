import { execFile } from 'node:child_process';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RecoveryForkInput, RecoveryForkRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { deriveLaunch } from '../configuration/derive-launch.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { recoveryGit } from '../worktrees/recovery-fork-source.js';
import { inspectSupplementalAdoptionGit } from '../worktrees/source-adoption-git.js';
import { QUALIFICATION_SOURCE_PROBE } from './environment-qualification.js';
import { createEventRepository } from './event-repository.js';
import { createPodManager } from './pod-manager.js';
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
async function fixture(noRequirements = false) {
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
    f.ctx.podRepo.atomically!(() => snapshots.admitRecoveryFork(id, createPod, initializePod));
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
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, child.id)).toThrow('fresh enabled checks');
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
