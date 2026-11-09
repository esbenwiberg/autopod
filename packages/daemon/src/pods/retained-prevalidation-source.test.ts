import { execFile } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { fingerprintPreservedWorkspace } from './artifact-snapshot-receipt.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import { createRetainedCheckpointRepository } from './retained-checkpoint-repository.js';
import { retainedPrevalidationSource } from './retained-prevalidation-source.js';
import { assertSourceDeliveryAllowed } from './source-custody-guards.js';

const exec = promisify(execFile);
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(fault?: string) {
  const f = await retainedCheckpointFixture('prevalidation', true, true, true, 'local');
  fixtures.push(f);
  vi.stubEnv('DATA_DIR', f.root);
  f.deps.readLaunch = f.ctx.deps.launchConfiguration!.read;
  f.deps.executionSettings = f.ctx.deps.launchConfiguration!.executionSettings;
  await materializeCheckpointFixture(f);
  f.ctx.podRepo.update(f.podId, { validationAttempts: 0 });
  const p = f.pod();
  const runId = f.ctx.podRepo.taskExecutions!.beginRun(f.podId, 1, 1, {
    runtime: p.runtime,
    model: p.model,
    providerAccountId: p.providerAccountIdSnapshot ?? null,
    resource: { containerId: f.containerId, executionTarget: 'local' },
  });
  f.ctx.db
    .prepare('UPDATE task_agent_runs SET ended_at=? WHERE id=?')
    .run(new Date().toISOString(), runId);
  const journal = f.ctx.podRepo.completionJournal!;
  journal.begin(p);
  journal.settle(p, 'Execution stopped; original worker result remains unknown');
  journal.mark(p, 'ready', true);
  const source = await f.worktrees.inspectSourceAdoption(p.worktreePath!, p.branch);
  const archive = path.join(f.root, 'retained-archive');
  await cp(p.worktreePath!, archive, { recursive: true });
  const resourceKey = JSON.stringify(['docker', 'fixture-engine', f.containerId]);
  f.cm.getResourceKey = vi.fn(async () => resourceKey);
  const run = f.ctx.db.prepare('SELECT binding FROM task_agent_runs WHERE id=?').get(runId) as {
    binding: string;
  };
  const taskId = f.ctx.podRepo.taskExecutions!.snapshot(f.podId).taskId;
  const proof = {
    run: { id: runId, podId: f.podId, generation: 1, cycle: 1, binding: run.binding },
    resourceKey,
  };
  const receipt = {
    state: fault === 'pending' ? 'pending' : 'settled',
    resourcesRetained: true,
    request: { requestKey: 'sealed-prevalidation', expectedGeneration: 1 },
    podId: f.podId,
  };
  const preserved = {
    source,
    archivedSource: source,
    archiveFingerprint: await fingerprintPreservedWorkspace(archive, () => {}),
    archivePath: archive,
    resourceKey,
    proof: 'docker-stopped',
    exitCode: 'unknown',
  };
  if (fault === 'dirty-seal') preserved.archivedSource = { ...source, worktreeClean: false };
  if (fault === 'wrong-branch') preserved.archivedSource = { ...source, branch: 'different' };
  if (fault === 'wrong-namespace') preserved.resourceKey = 'different';
  if (fault === 'missing-fingerprint') preserved.archiveFingerprint.sha256 = '';
  if (fault === 'wrong-run') proof.run.id = 'different';
  if (fault === 'generation') proof.run.generation = 2;
  f.ctx.db
    .prepare(`INSERT INTO stalled_worker_recoveries
    (request_key,pod_id,task_id,container_id,request_hash,binding,receipt,archive_path,original_evidence,preservation)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(
      'sealed-prevalidation',
      f.podId,
      taskId,
      f.containerId,
      'request',
      JSON.stringify(proof),
      JSON.stringify(receipt),
      archive,
      JSON.stringify({
        pod: {
          worktreePath: p.worktreePath,
          lastValidationResult: fault === 'prior-result' ? f.result : null,
        },
      }),
      fault === 'missing-preservation' ? null : JSON.stringify(preserved),
    );
  f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
    const current = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
    return {
      head: current.commitSha,
      tree: current.treeSha,
      baseCommitSha: f.input.checkpointHead,
    };
  });
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  const selection = f.recovery.selection(f.podId);
  if (selection) f.input.expectedResultHash = selection.expectedResultHash;
  return {
    ...f,
    runId,
    archive,
    resourceKey,
    taskId,
    archiveFingerprint: preserved.archiveFingerprint,
  };
}

describe('first checks from positively sealed pre-validation Docker source', () => {
  it.each([
    'pass',
    'fail',
  ] as const)('runs one fresh checks-only invocation (%s), retaining the null result and unknown worker evidence', async (outcome) => {
    const f = await fixture();
    const original = f.pod();
    expect(original.lastValidationResult).toBeNull();
    expect(f.recovery.selection(f.podId)).not.toBeNull();
    expect(f.recovery.inspect(f.podId).nextSteps.join(' ')).not.toContain('use --check');
    expect(f.recovery.inspect(f.podId).nextSteps.join(' ')).toContain('exact sealed HEAD');
    const before = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
      ...(await validate(config)),
      overall: outcome,
      taskReview: {
        status: 'pass',
        reasoning: 'New independent source-bound review',
        issues: [],
        model: 'fixture',
        screenshots: [],
        diff: config.diff,
      },
    }));
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    const selected = f.recovery.list(f.podId)[0]!;
    expect(selected).toMatchObject({
      blocked: null,
      activated: { generation: 2 },
      originalEvidence: {
        result: null,
        prevalidationSource: {
          head: f.input.checkpointHead,
          runId: f.runId,
          archiveSha256: f.archiveFingerprint.sha256,
        },
      },
    });
    expect(f.pod().skipAgent).toBe(true);
    await f.manager.processPod(f.podId);
    const record = f.recovery.list(f.podId)[0]!;
    expect(record.blocked, f.pod().failureReason ?? '').toBeNull();
    expect(record.checked?.result.overall).toBe(outcome);
    expect(record.originalEvidence.result).toBeNull();
    expect(f.pod().status).toBe(outcome === 'pass' ? 'validated' : 'failed');
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(vi.mocked(f.cm.stop).mock.calls.filter(([id]) => id === f.containerId)).toHaveLength(0);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId)).toMatchObject({
      taskId: before.taskId,
      agentRunCount: before.agentRunCount,
      tokenBudget: before.tokenBudget,
    });
    expect(f.ctx.db.prepare('SELECT outcome FROM task_agent_runs WHERE id=?').get(f.runId)).toEqual(
      { outcome: null },
    );
    expect(await readFile(path.join(f.archive, 'ignored-report.txt'), 'utf8')).toContain(
      'Original report',
    );
    expect(await readFile(path.join(original.worktreePath!, 'source.ts'), 'utf8')).toContain(
      'preserved',
    );
    if (outcome === 'fail') expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow();
    const replay = await createRetainedCheckpointRecovery(f.deps).continueRetained(
      f.podId,
      f.input,
      f.actor,
    );
    expect(replay.id).toBe(record.id);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
  });
  it.each([
    'pending',
    'dirty-seal',
    'wrong-branch',
    'wrong-namespace',
    'missing-fingerprint',
    'wrong-run',
    'generation',
    'prior-result',
    'missing-preservation',
  ])('rejects incomplete or mismatched sealed proof: %s', async (fault) => {
    const f = await fixture(fault);
    expect(retainedPrevalidationSource(f.ctx.db, f.pod())).toBeNull();
    expect(f.recovery.selection(f.podId)).toBeNull();
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow();
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it.each([
    'prepare-only',
    'remote-source',
    'wrong-clean-head',
    'wrong-tree',
    'running',
    'late-running',
    'unread-guidance',
    'unsettled-worker',
  ])('does not turn sealed source into broader authority: %s', async (fault) => {
    const f = await fixture();
    const request = { ...f.input, prepareOnly: false, remoteHead: undefined as string | undefined };
    if (fault === 'prepare-only') request.prepareOnly = true;
    if (fault === 'remote-source') request.remoteHead = 'd'.repeat(40);
    if (fault === 'wrong-clean-head') {
      const cwd = f.pod().worktreePath!;
      await writeFile(path.join(cwd, 'source.ts'), 'export const changed = true;');
      await exec('git', ['add', '.'], { cwd });
      await exec(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Unsealed new clean source',
        ],
        { cwd },
      );
      request.checkpointHead = (
        await f.worktrees.inspectSourceAdoption(cwd, f.pod().branch)
      ).commitSha;
    }
    if (fault === 'wrong-tree') {
      const inspect = f.worktrees.inspectSourceAdoption.getMockImplementation()!;
      f.worktrees.inspectSourceAdoption.mockImplementation(async (...args) => ({
        ...(await inspect(...args)),
        treeSha: 'e'.repeat(40),
      }));
    }
    if (fault === 'running') vi.mocked(f.cm.getStatus).mockResolvedValue('running');
    if (fault === 'late-running')
      vi.mocked(f.cm.getStatus).mockResolvedValueOnce('stopped').mockResolvedValue('running');
    if (fault === 'unread-guidance')
      f.deps.assertGuidanceCollected.mockImplementation(() => {
        throw Error('Unread guidance');
      });
    if (fault === 'unsettled-worker')
      vi.spyOn(f.ctx.podRepo.taskExecutions!, 'assertCanDelete').mockImplementation(() => {
        throw Error('Worker still active');
      });
    await expect(f.recovery.continueRetained(f.podId, request, f.actor)).rejects.toThrow();
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('fences a new clean host commit after claim and before activation', async () => {
    const f = await fixture();
    const select = f.worktrees.selectRetainedContinuationSource.getMockImplementation()!;
    f.worktrees.selectRetainedContinuationSource.mockImplementationOnce(async (input) => {
      const selected = await select(input);
      const cwd = f.pod().worktreePath!;
      await writeFile(path.join(cwd, 'source.ts'), 'export const postClaimDrift = true;');
      await exec('git', ['add', '.'], { cwd });
      await exec(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Clean source drift after admission',
        ],
        { cwd },
      );
      return selected;
    });
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      activated: null,
      blocked: { code: 'CHECKPOINT_RECOVERY_BLOCKED' },
    });
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('does not certify an apparent pass without fresh independent review', async () => {
    const f = await fixture();
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    await expect(f.manager.processPod(f.podId)).rejects.toMatchObject({
      code: 'CONTINUATION_REVIEW_UNVERIFIED',
    });
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      checked: null,
      blocked: { code: 'CONTINUATION_REVIEW_UNVERIFIED' },
    });
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
  });
  it.each([
    'missing',
    'changed',
  ])('retains custody without dispatch if the sealed archive is %s', async (fault) => {
    const f = await fixture();
    if (fault === 'missing') await rm(f.archive, { recursive: true, force: true });
    else await writeFile(path.join(f.archive, 'ignored-report.txt'), 'Changed sealed evidence');
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    const operation = f.recovery.list(f.podId)[0]!;
    expect(operation.blocked).not.toBeNull();
    expect(operation.activated).toBeNull();
    expect(f.pod().lifecycleGeneration).toBe(1);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('keeps existing validation-history and report-based selection meanings unchanged', async () => {
    const f = await fixture();
    const identity = {
      source: null,
      contract: null,
      commands: null,
      environment: null,
      implementation: null,
    };
    f.ctx.podRepo.taskRetries!.admit(f.podId, 1, identity, 'f'.repeat(64), []);
    expect(createRetainedCheckpointRepository(f.ctx.db).selectionEvidence(f.pod())).toBeNull();
  });
});
