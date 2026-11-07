import { execFileSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pod, StalledWorkerRecoveryRequest } from '@autopod/shared';
import Dockerode from 'dockerode';
import Fastify from 'fastify';
import tar from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stalledWorkerRecoveryRoutes } from '../api/routes/stalled-worker-recovery.js';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import {
  createFailingValidationResult,
  createTestContext,
  logger,
} from '../test-utils/mock-helpers.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import {
  fingerprintArtifactSnapshot,
  fingerprintPreservedWorkspace,
} from './artifact-snapshot-receipt.js';
import { createPodManager } from './pod-manager.js';
import { UNRESOLVED_EXECUTION_RECOVERY_MESSAGE } from './reconciliation-ownership.js';
import { assertCheckpointResourceNotRetained } from './retained-checkpoint-repository.js';
import { assertSourceAvailable } from './source-custody-guards.js';
import { createStalledWorkerRecovery } from './stalled-worker-recovery.js';
import { ownsStalledWorkerStop } from './stalled-worker-recovery-repository.js';
import { validateTransition } from './state-machine.js';
import { unavailableWorkerInputs, workerBindingHash } from './worker-retry-history.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllEnvs();
});
async function fixture(
  options: {
    legacy?: boolean;
    sandbox?: boolean;
    containerId?: string;
    workerDirty?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stalled-worker-'));
  const worktree = path.join(root, 'source');
  await mkdir(worktree);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
  git('init', '-b', 'fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  await writeFile(path.join(worktree, 'source.swift'), 'let preserved = true\n');
  await writeFile(path.join(worktree, '.gitignore'), 'ignored-unsynced.txt\n');
  await writeFile(path.join(worktree, 'check.sh'), '#!/bin/sh\necho preserved\n', { mode: 0o751 });
  git('add', '.');
  git('commit', '-m', 'fixture');
  const ctx = createTestContext();
  cleanup.push(async () => {
    if (ctx.db.open) ctx.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const manager = createPodManager(ctx.deps);
  const p = manager.createSession(
    { profileName: 'test-profile', task: 'Recover retained work', branch: 'fixture' },
    'operator',
  );
  const id = p.id,
    containerId = options.containerId ?? 'f'.repeat(64);
  if (options.sandbox) ctx.podRepo.update(id, { executionTarget: 'sandbox' });
  ctx.podRepo.update(id, {
    status: 'running',
    containerId,
    worktreePath: worktree,
    profileSnapshot: ctx.profileStore.get('test-profile'),
    lastValidationResult: createFailingValidationResult(id),
    failureReason: 'Configured test timed out; checks incomplete',
    lastRecoveryTrigger: 'restart',
    lastCorrectionMessage: 'Original worker ownership unresolved',
  });
  ctx.podRepo.completionJournal!.begin(ctx.podRepo.getOrThrow(id));
  const runId = ctx.podRepo.taskExecutions!.beginRun(id, 1, 1, {
    runtime: p.runtime,
    model: p.model,
    providerAccountId: null,
    ...(!options.legacy && {
      resource: {
        containerId,
        executionTarget: options.sandbox ? ('sandbox' as const) : ('local' as const),
      },
    }),
  });
  let status: 'running' | 'stopped' | 'unknown' = 'running';
  ctx.containerManager.getResourceKey = vi.fn(async () =>
    JSON.stringify(['docker', 'engine', containerId]),
  );
  vi.mocked(ctx.containerManager.getStatus).mockImplementation(async () => status);
  vi.mocked(ctx.containerManager.stop).mockImplementation(async () => {
    expect(ownsStalledWorkerStop(ctx.db, containerId)).toBe(true);
    expect(() => assertCheckpointResourceNotRetained(ctx.db, containerId)).toThrow(
      'Stop-and-retain',
    );
    status = 'stopped';
  });
  vi.mocked(ctx.containerManager.extractDirectoryFromContainer).mockImplementation(
    async (_id, _source, dest, excludes, extractOptions) => {
      extractOptions?.assertCurrent?.();
      expect(status).toBe('stopped');
      expect(excludes).toEqual([]);
      await cp(worktree, dest, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await writeFile(path.join(dest, 'ignored-unsynced.txt'), 'Retain me');
      if (options.workerDirty)
        await writeFile(path.join(dest, 'source.swift'), 'let uncommitted = true\n');
      extractOptions?.assertCurrent?.();
    },
  );
  ctx.worktreeManager.inspectSource = vi.fn(async (directory) => {
    const readGit = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }).trim();
    return {
      branch: 'fixture',
      commitSha: readGit('rev-parse', 'HEAD'),
      treeSha: readGit('rev-parse', 'HEAD^{tree}'),
      worktreeClean: readGit('status', '--porcelain') === '',
    };
  });
  ctx.worktreeManager.inspectSourcePreservation = ctx.worktreeManager.inspectSource;
  const deps = {
    podRepo: ctx.podRepo,
    getContainerManager: () => ctx.containerManager,
    worktreeManager: ctx.worktreeManager,
    isIdle: vi.fn(() => true),
    isGoal: vi.fn(() => false),
    assertGuidanceCollected: vi.fn(),
    preserveWorkspace: vi.fn(async () => {
      const archive = ctx.podRepo.stalledRecoveries!.latest(id)!.archivePath;
      for (const entry of await readdir(archive))
        if (entry !== '.git')
          await cp(path.join(archive, entry), path.join(worktree, entry), {
            recursive: true,
            force: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
    }),
    transition: (pod: Pod, to: 'failed') => {
      validateTransition(pod.id, pod.status, to);
      ctx.podRepo.update(id, { status: to });
    },
    emit: vi.fn(),
    root: path.join(root, 'archives'),
  };
  const controller = () => createStalledWorkerRecovery(deps);
  const service = controller();
  const selection = service.inspectStalledWorkerRecovery(id);
  const input: StalledWorkerRecoveryRequest = {
    requestKey: 'operator-stop',
    expectedGeneration: 1,
    expectedBinding: selection.binding,
    reason: 'Retain committed source before recovering the blocked execution',
  };
  const actor = { type: 'human' as const, userId: 'operator' };
  return {
    ...ctx,
    runtimeDeps: ctx.deps,
    root,
    worktree,
    git,
    id,
    runId,
    containerId,
    manager,
    deps,
    controller,
    service,
    input,
    actor,
    setStatus: (value: typeof status) => {
      status = value;
    },
    pod: () => ctx.podRepo.getOrThrow(id),
    submit: () => service.recoverStalledWorker(id, input, actor),
  };
}

describe('desktop stalled Docker recovery', () => {
  it('inspection is read-only, including an ordinary orphan not selected by sandbox reconciliation', async () => {
    const f = await fixture();
    expect(f.service.inspectStalledWorkerRecovery(f.id).canStop).toBe(true);
    expect(f.podRepo.taskExecutions!.terminationReconciliations(f.id).pending).toEqual([]);
    expect(f.podRepo.taskExecutions!.hasActiveRun(f.id)).toBe(true);
    expect(f.containerManager.stop).not.toHaveBeenCalled();
    expect(f.podRepo.stalledRecoveries!.latest(f.id)).toBeNull();
  });
  it('retains a pre-validation orphan with the exact daemon restart hold without inventing result or usage', async () => {
    const f = await fixture();
    f.podRepo.update(f.id, {
      status: 'failed',
      lastValidationResult: null,
      failureReason: null,
      lastCorrectionMessage: UNRESOLVED_EXECUTION_RECOVERY_MESSAGE,
    });
    const before = f.podRepo.taskExecutions!.snapshot(f.id);
    const view = f.service.inspectStalledWorkerRecovery(f.id);
    expect(view.canStop).toBe(true);
    f.input.expectedBinding = view.binding;
    expect((await f.submit()).state).toBe('settled');
    expect(f.pod().lastValidationResult).toBeNull();
    const after = f.podRepo.taskExecutions!.snapshot(f.id);
    expect(after.agentRunCount).toBe(before.agentRunCount);
    expect(after.recordedTotalTokens).toBe(before.recordedTotalTokens);
    expect(f.containerManager.stop).toHaveBeenCalledTimes(1);
  });

  it('does not infer pre-validation recovery eligibility from an arbitrary restart diagnostic', async () => {
    const f = await fixture();
    f.podRepo.update(f.id, { lastValidationResult: null, failureReason: null });
    expect(f.service.inspectStalledWorkerRecovery(f.id).canStop).toBe(false);
    expect(f.containerManager.stop).not.toHaveBeenCalled();
  });

  it('stops once, archives before settlement and exposes existing checks-only eligibility without starting anything', async () => {
    const f = await fixture(),
      before = f.pod();
    const result = await f.submit();
    expect(result.state).toBe('settled');
    expect(f.pod().status).toBe('failed');
    expect(f.pod().finalization?.agentSettledAt).toBeTruthy();
    expect(f.pod().finalization?.sourcePreservedAt).toBeTruthy();
    const record = f.podRepo.stalledRecoveries!.latest(f.id)!;
    expect(await readFile(path.join(record.archivePath, 'ignored-unsynced.txt'), 'utf8')).toBe(
      'Retain me',
    );
    expect(f.deps.preserveWorkspace).toHaveBeenCalledTimes(1);
    expect(f.podRepo.taskExecutions!.hasActiveRun(f.id)).toBe(false);
    expect(
      f.db.prepare('SELECT outcome,failure_category FROM task_agent_runs WHERE id=?').get(f.runId),
    ).toEqual({ outcome: null, failure_category: null });
    expect(f.pod().lastValidationResult).toEqual(before.lastValidationResult);
    expect(f.pod().failureReason).toEqual(before.failureReason);
    expect(f.pod().containerId).toBe(f.containerId);
    expect(f.pod().validationAttempts).toBe(before.validationAttempts);
    expect(f.pod().inputTokens).toBe(before.inputTokens);
    expect(f.git('rev-parse', 'HEAD')).toBe(
      record.binding.hostSource && (record.binding.hostSource as { commitSha: string }).commitSha,
    );
    expect(() => f.manager.assertCanRetryValidation(f.id)).not.toThrow();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
    expect(f.containerManager.start).not.toHaveBeenCalled();
    expect(f.runtime.spawn).not.toHaveBeenCalled();
    expect(f.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(await f.submit()).toEqual(result);
    expect(f.containerManager.stop).toHaveBeenCalledTimes(1);
    expect(() => f.db.exec('DELETE FROM stalled_worker_recoveries')).toThrow('cannot be deleted');
    expect(() => f.db.prepare('UPDATE stalled_worker_recoveries SET receipt=?').run('{}')).toThrow(
      'immutable',
    );
  });
  it('retains current infrastructure reports and uncollected guidance rather than claiming they are repaired', async () => {
    const f = await fixture();
    f.escalationRepo.insert({
      id: 'infra',
      podId: f.id,
      type: 'report_blocker',
      timestamp: new Date().toISOString(),
      response: null,
      payload: {
        kind: 'infrastructure',
        lifecycleGeneration: 1,
        requiresResponse: false,
        owner: 'validation',
        phase: 'test',
        description: 'Runner unavailable',
        attempted: ['test'],
        needs: 'Qualified runner',
      },
    });
    f.deps.assertGuidanceCollected.mockImplementation(() => {
      throw new Error('Uncollected go on nudge');
    });
    f.input.expectedBinding = f.service.inspectStalledWorkerRecovery(f.id).binding;
    expect(f.service.inspectStalledWorkerRecovery(f.id).guidanceBlocker).toContain('Uncollected');
    await f.submit();
    expect(f.podRepo.hasInfrastructureBlocker!(f.id)).toBe(true);
    expect(() => f.manager.assertCanRetryValidation(f.id)).toThrow(
      'Infrastructure remains blocked',
    );
    expect(f.deps.assertGuidanceCollected).toHaveBeenCalled();
  });
  it('coalesces duplicate clicks and reconstructs a lost stop response without dispatching twice', async () => {
    const f = await fixture();
    vi.mocked(f.containerManager.stop).mockRejectedValueOnce(new Error('Lost stop response'));
    const a = f.submit(),
      b = f.submit();
    expect(a).toBe(b);
    expect((await a).state).toBe('pending');
    expect(() => f.podRepo.update(f.id, { status: 'failed' })).toThrow('saved stop-and-retain');
    expect(() => assertSourceAvailable(f.db, f.id)).toThrow('saved stop-and-retain');
    expect(() => f.podRepo.delete(f.id)).toThrow('saved stop-and-retain');
    expect(() => f.podRepo.incrementLifecycleGeneration(f.id)).toThrow('saved stop-and-retain');
    const reopened = f.controller();
    expect((await reopened.recoverStalledWorker(f.id, f.input, f.actor)).state).toBe('pending');
    f.setStatus('stopped');
    expect((await reopened.recoverStalledWorker(f.id, f.input, f.actor)).state).toBe('settled');
    expect(f.containerManager.stop).toHaveBeenCalledTimes(1);
  });
  it('handles already stopped Docker without dispatch; unknown observations never settle', async () => {
    const f = await fixture();
    f.setStatus('stopped');
    await f.submit();
    expect(f.containerManager.stop).not.toHaveBeenCalled();
    const other = await fixture();
    other.setStatus('unknown');
    await expect(other.submit()).rejects.toThrow('unknown');
    expect(other.podRepo.stalledRecoveries!.latest(other.id)).toBeNull();
    expect(other.podRepo.taskExecutions!.hasActiveRun(other.id)).toBe(true);
  });
  it.each([
    'active',
    'missing-identity',
    'stale-generation',
    'pending-decision',
    'sandbox',
    'sidecar',
    'shared-resource',
    'review-required',
  ] as const)('refuses %s before stop admission', async (fault) => {
    const f = await fixture({ legacy: fault === 'missing-identity', sandbox: fault === 'sandbox' });
    if (fault === 'active') f.deps.isIdle.mockReturnValue(false);
    if (fault === 'review-required') f.podRepo.update(f.id, { status: 'review_required' });
    if (fault === 'stale-generation') f.input.expectedGeneration = 2;
    if (fault === 'pending-decision')
      f.podRepo.update(f.id, {
        pendingEscalation: { id: 'pending', type: 'ask_human', question: 'Decide' },
      } as never);
    if (fault === 'sidecar') f.podRepo.update(f.id, { requireSidecars: ['db'] });
    if (fault === 'shared-resource') {
      const p = f.manager.createSession(
        { profileName: 'test-profile', task: 'Other owner' },
        'operator',
      );
      f.podRepo.update(p.id, { containerId: f.containerId });
    }
    await expect(f.submit()).rejects.toThrow();
    expect(f.containerManager.stop).not.toHaveBeenCalled();
    expect(f.podRepo.stalledRecoveries!.latest(f.id)).toBeNull();
  });
  it('retains unknown stop/preservation failures and rejects changed request or actor', async () => {
    const f = await fixture();
    f.deps.preserveWorkspace.mockRejectedValueOnce(new Error('Preservation failed'));
    await expect(f.submit()).rejects.toThrow('Preservation failed');
    expect(f.podRepo.taskExecutions!.hasActiveRun(f.id)).toBe(true);
    expect(f.pod().status).toBe('running');
    await expect(
      f.service.recoverStalledWorker(
        f.id,
        { ...f.input, reason: 'A changed request must not steal the intent' },
        f.actor,
      ),
    ).rejects.toThrow('conflicts');
    await expect(
      f.service.recoverStalledWorker(f.id, f.input, { type: 'human', userId: 'other' }),
    ).rejects.toThrow('conflicts');
    expect((await f.controller().recoverStalledWorker(f.id, f.input, f.actor)).state).toBe(
      'settled',
    );
    expect(f.containerManager.stop).toHaveBeenCalledTimes(1);
  });
  it('refuses provider or host source drift after an admitted uncertain stop', async () => {
    const f = await fixture();
    vi.mocked(f.containerManager.stop).mockRejectedValue(new Error('unknown'));
    await f.submit();
    vi.mocked(f.containerManager.getResourceKey!).mockResolvedValue('different engine');
    await expect(f.submit()).rejects.toThrow('engine/resource changed');
    vi.mocked(f.containerManager.getResourceKey!).mockResolvedValue(
      JSON.stringify(['docker', 'engine', f.containerId]),
    );
    await writeFile(path.join(f.worktree, 'source.swift'), 'changed after admission');
    await expect(f.submit()).rejects.toThrow('Host Git source changed');
    expect(f.podRepo.taskExecutions!.hasActiveRun(f.id)).toBe(true);
  });
  it.skipIf(!process.env.AUTOPOD_STALLED_DOCKER_FIXTURE_IMAGE).each([false, true])(
    'preserves committed and ignored bytes with one real disposable Docker stop (materialized archive: %s)',
    async (materializedArchive) => {
      const image = process.env.AUTOPOD_STALLED_DOCKER_FIXTURE_IMAGE;
      const socketPath = process.env.AUTOPOD_STALLED_DOCKER_FIXTURE_SOCKET;
      if (!image?.startsWith('sha256:') || !socketPath)
        throw new Error('Explicit cached image ID and local socket required');
      const docker = new Dockerode({ socketPath });
      await docker.getImage(image).inspect();
      const owned = await docker.createContainer({
        Image: image,
        Cmd: ['sleep', '300'],
        User: '1000:1000',
        Labels: { 'autopod.fixture': 'stalled-worker-recovery' },
        HostConfig: {
          NetworkMode: 'none',
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Memory: 67108864,
          PidsLimit: 32,
        },
      });
      try {
        await owned.start();
        const f = await fixture({ containerId: owned.id });
        const pack = tar.pack();
        const upload = owned.putArchive(pack, { path: '/' });
        async function add(directory: string, prefix: string): Promise<void> {
          pack.entry({ name: prefix, type: 'directory', uid: 1000, gid: 1000, mode: 0o755 });
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name),
              name = `${prefix}/${entry.name}`;
            if (entry.isDirectory()) await add(file, name);
            else if (entry.isFile())
              pack.entry(
                { name, uid: 1000, gid: 1000, mode: (await stat(file)).mode & 0o777 },
                entry.name === 'source.swift'
                  ? Buffer.from('let uncommitted = true\n')
                  : await readFile(file),
              );
          }
        }
        await add(f.worktree, 'workspace');
        for (const name of [
          'workspace/.agents',
          'workspace/.agents/skills',
          'workspace/.agents/skills/example',
          'workspace/.claude',
        ])
          pack.entry({ name, type: 'directory', uid: 1000, gid: 1000, mode: 0o755 });
        pack.entry(
          { name: 'workspace/.agents/skills/example/SKILL.md', uid: 1000, gid: 1000, mode: 0o644 },
          'pinned skill',
        );
        pack.entry({
          name: 'workspace/.claude/skills',
          type: 'symlink',
          linkname: '../.agents/skills',
          uid: 1000,
          gid: 1000,
        });
        pack.entry(
          { name: 'workspace/ignored-unsynced.txt', uid: 1000, gid: 1000, mode: 0o600 },
          'Retain me',
        );
        pack.finalize();
        await upload;
        // A prior sync can have materialized this generated alias as a directory.
        // Empty directories keep the original canonical Git source clean.
        await mkdir(path.join(f.worktree, '.claude/skills'), { recursive: true });
        const cm = new DockerContainerManager({ docker, logger, managedDatabase: f.db });
        const gitManager = new LocalWorktreeManager({
          logger,
          cacheDir: path.join(f.root, 'cache'),
          worktreeDir: path.join(f.root, 'worktrees'),
        });
        f.worktreeManager.inspectSourcePreservation = vi.fn(
          gitManager.inspectSourcePreservation.bind(gitManager),
        );
        f.containerManager.getResourceKey = vi.fn(cm.getResourceKey.bind(cm));
        f.containerManager.getStatus = vi.fn(cm.getStatus.bind(cm));
        f.containerManager.stop = vi.fn(cm.stop.bind(cm));
        f.containerManager.extractDirectoryFromContainer = vi.fn(
          async (...args: Parameters<DockerContainerManager['extractDirectoryFromContainer']>) => {
            await cm.extractDirectoryFromContainer(...args);
            if (materializedArchive && args[1] === '/workspace' && args[4]?.preserveRootMode) {
              // Simulate the former adapter BEFORE the controller seals this archive.
              // Reconciliation must preserve its recorded representation unchanged.
              const alias = path.join(args[2], '.claude/skills');
              await rm(alias);
              await cp(path.join(args[2], '.agents/skills'), alias, { recursive: true });
            }
          },
        );
        f.containerManager.execInContainer = vi.fn(cm.execInContainer.bind(cm));
        vi.stubEnv('DATA_DIR', path.join(f.root, 'manager-data'));
        const facade = createPodManager(f.runtimeDeps);
        const result = await facade.recoverStalledWorker(f.id, f.input, f.actor);
        expect(result.state).toBe('settled');
        expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
        expect(f.containerManager.extractDirectoryFromContainer).toHaveBeenCalledTimes(1);
        const archive = f.podRepo.stalledRecoveries!.latest(f.id)!.archivePath;
        expect(await readFile(path.join(archive, 'ignored-unsynced.txt'), 'utf8')).toBe(
          'Retain me',
        );
        expect(
          execFileSync('git', ['-C', archive, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        ).toBe(f.git('rev-parse', 'HEAD'));
        expect(await readFile(path.join(archive, 'source.swift'), 'utf8')).toBe(
          'let uncommitted = true\n',
        );
        expect(await readFile(path.join(f.worktree, 'source.swift'), 'utf8')).toBe(
          'let uncommitted = true\n',
        );
        for (const root of [archive, f.worktree]) {
          expect((await lstat(path.join(root, '.claude/skills'))).isSymbolicLink()).toBe(
            !materializedArchive,
          );
          if (!materializedArchive)
            expect(await readlink(path.join(root, '.claude/skills'))).toBe('../.agents/skills');
          expect(await readFile(path.join(root, '.claude/skills/example/SKILL.md'), 'utf8')).toBe(
            'pinned skill',
          );
        }
        expect((await stat(path.join(archive, 'check.sh'))).mode & 0o777).toBe(0o751);
        expect((await stat(path.join(f.worktree, 'check.sh'))).mode & 0o777).toBe(0o751);
        expect(f.git('status', '--porcelain')).not.toBe('');
        expect(await cm.getStatus(owned.id)).toBe('stopped');
        expect(f.containerManager.stop).toHaveBeenCalledTimes(1);
        expect((await owned.inspect()).Config.Labels['autopod.fixture']).toBe(
          'stalled-worker-recovery',
        );
      } finally {
        await owned.remove({ force: true });
      }
    },
    45000,
  );

  it('preserves uncommitted worker source without committing it or deadlocking settlement', async () => {
    const f = await fixture({ workerDirty: true });
    const head = f.git('rev-parse', 'HEAD');
    expect((await f.submit()).state).toBe('settled');
    expect(await readFile(path.join(f.worktree, 'source.swift'), 'utf8')).toBe(
      'let uncommitted = true\n',
    );
    expect(f.git('rev-parse', 'HEAD')).toBe(head);
    expect(f.git('status', '--porcelain')).not.toBe('');
    expect(f.pod().lastValidationResult?.overall).toBe('fail');
  });
  it('streams a full workspace beyond artifact-output limits without weakening artifact receipts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'large-stalled-workspace-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const file = await open(path.join(root, 'dependency-cache'), 'w');
    await file.truncate(1073741825);
    await file.close();
    await expect(fingerprintArtifactSnapshot(root)).rejects.toThrow('exceeds 1 GiB');
    const result = await fingerprintPreservedWorkspace(root, () => {});
    expect(result.bytes).toBe(1073741825);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30000);

  it('seals the full archive and refuses later ignored-byte drift without overwriting it', async () => {
    const f = await fixture();
    f.deps.preserveWorkspace.mockRejectedValueOnce(new Error('sync interrupted'));
    await expect(f.submit()).rejects.toThrow('sync interrupted');
    const archive = f.podRepo.stalledRecoveries!.latest(f.id)!.archivePath;
    await writeFile(path.join(archive, 'ignored-unsynced.txt'), 'changed ignored evidence');
    await expect(f.controller().recoverStalledWorker(f.id, f.input, f.actor)).rejects.toThrow(
      'bytes or modes changed',
    );
    expect(f.containerManager.extractDirectoryFromContainer).toHaveBeenCalledTimes(1);
    expect(f.podRepo.taskExecutions!.hasActiveRun(f.id)).toBe(true);
  });
  it('requires canonical Git source to match the archived final commit before settling', async () => {
    const f = await fixture();
    f.worktreeManager.inspectSourcePreservation = vi.fn(async (directory, branch) => ({
      branch,
      commitSha: directory.includes('archives') ? 'a'.repeat(40) : 'b'.repeat(40),
      treeSha: 'c'.repeat(40),
      worktreeClean: true,
    }));
    await expect(f.submit()).rejects.toThrow('Canonical Git source does not match');
    expect(f.podRepo.taskExecutions!.hasActiveRun(f.id)).toBe(true);
    expect(f.pod().finalization?.agentSettledAt).toBeNull();
  });
  it('records stop timeout honestly and never redispatches an uncertain request', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    vi.mocked(f.containerManager.stop).mockImplementation(() => new Promise(() => {}));
    const request = f.submit();
    await vi.waitFor(() => expect(f.containerManager.stop).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30000);
    const result = await request;
    expect(result.state).toBe('pending');
    expect(result.message).toContain('will NOT be repeated');
    expect((await f.controller().recoverStalledWorker(f.id, f.input, f.actor)).state).toBe(
      'pending',
    );
    expect(f.containerManager.stop).toHaveBeenCalledTimes(1);
    expect(f.service.inspectStalledWorkerRecovery(f.id).operation?.message).toContain(
      'Provider recovery is required',
    );
  });
  it('settles a categorized unknown worker without inventing an exit or resetting its retry history', async () => {
    const f = await fixture(),
      p = f.pod();
    const attempt = f.podRepo.workerRetries!.admit(
      f.id,
      1,
      unavailableWorkerInputs,
      workerBindingHash({ runtime: p.runtime, model: p.model, providerAccountId: null }),
      [1000, 5000],
      f.runId,
    );
    f.podRepo.workerRetries!.start(attempt.id);
    f.podRepo.taskExecutions!.retainUnverifiedRun(f.runId);
    f.input.expectedBinding = f.service.inspectStalledWorkerRecovery(f.id).binding;
    await f.submit();
    expect(
      f.db.prepare('SELECT outcome,failure_category FROM task_agent_runs WHERE id=?').get(f.runId),
    ).toEqual({ outcome: 'failed', failure_category: 'execution_termination_unverified' });
    const state = f.podRepo.workerRetries!.state(f.id);
    expect(state.admissionCount).toBe(1);
    expect(state.latest?.outcome).toBe('unknown');
    expect(state.authorizations).toHaveLength(0);
  });

  it('requires authenticated human, strict API input and read-only GET', async () => {
    const f = await fixture();
    const app = Fastify();
    cleanup.push(() => app.close());
    let human = false;
    app.addHook('preHandler', async (request) => {
      if (human) request.user = { oid: 'operator' } as never;
    });
    app.setErrorHandler((e, _req, reply) =>
      reply.code((e as { statusCode?: number }).statusCode ?? 400).send({ message: e.message }),
    );
    stalledWorkerRecoveryRoutes(app, f.service);
    expect(
      (await app.inject({ method: 'GET', url: `/pods/${f.id}/stalled-worker-recovery` }))
        .statusCode,
    ).toBe(401);
    human = true;
    const read = await app.inject({ method: 'GET', url: `/pods/${f.id}/stalled-worker-recovery` });
    expect(read.json().canStop).toBe(true);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/pods/${f.id}/stalled-worker-recovery`,
          payload: { ...f.input, force: true },
        })
      ).statusCode,
    ).toBe(400);
    const result = await app.inject({
      method: 'POST',
      url: `/pods/${f.id}/stalled-worker-recovery`,
      payload: f.input,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().state).toBe('settled');
  });
});
