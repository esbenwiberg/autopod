import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repairGit, rewriteRepairFixture } from '../test-utils/approval-rewrite-repair-helpers.js';
import { pendingStatus } from '../test-utils/delivery-helpers.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { checkpointHash } from './retained-checkpoint-repository.js';
import { createRetainedFinalization } from './retained-finalization.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
  vi.unstubAllEnvs();
});
async function fixture(
  kind: 'continuation' | 'rewrite' | 'repair' | 'checked-repair' | 'unselected-repair' = 'rewrite',
) {
  const f =
    kind === 'continuation'
      ? await retainedCheckpointFixture('validation')
      : await rewriteRepairFixture();
  close.push(async () => {
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  });
  if (kind === 'continuation') {
    const result = { ...f.result, infrastructureFailure: undefined };
    f.ctx.podRepo.update(f.podId, {
      lastValidationResult: result,
      prUrl: 'https://github.com/org/repo/pull/7',
      baseBranch: 'main',
      options: { ...f.pod().options, output: 'pr' },
    });
    await materializeCheckpointFixture(f);
    const original = await f.worktrees.inspectSourceAdoption(f.pod().worktreePath!, f.pod().branch);
    f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => ({
      head: input.head,
      tree: original.treeSha,
      baseCommitSha: original.commitSha,
    }));
    await f.recovery.continueRetained(
      f.podId,
      { ...f.input, expectedResultHash: checkpointHash(result) },
      f.actor,
    );
    await f.recovery.wait(f.input.id);
    f.ctx.podRepo.retainedCheckpoints!.owned(f.input.id, () =>
      f.ctx.podRepo.update(f.podId, {
        status: 'review_required',
        containerId: '22222222-2222-4222-8222-222222222222',
      }),
    );
  } else if (kind === 'repair' || kind === 'checked-repair' || kind === 'unselected-repair') {
    if (!('request' in f)) throw new Error('Expected rewrite fixture');
    await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
    await f.recovery.wait(f.request.id);
    const repair = f.recovery.list(f.podId)[0]!;
    expect(repair.prepared).not.toBeNull();
    const cwd = repair.prepared!.worktree;
    await writeFile(path.join(cwd, 'source.ts'), 'export const repaired = true;\n');
    await repairGit(cwd, 'add', 'source.ts');
    await repairGit(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'repair',
    );
    if (kind === 'repair' || kind === 'checked-repair') {
      if (kind === 'checked-repair') {
        vi.stubEnv('DATA_DIR', f.root);
        f.ctx.podRepo.taskRetries!.authorize(
          f.podId,
          'repair-checks',
          'Authorize exactly the selected repaired source checks',
          f.actor,
          undefined,
          {
            recoveryId: repair.id,
            candidateHead: await repairGit(cwd, 'rev-parse', 'HEAD'),
            candidateTree: await repairGit(cwd, 'rev-parse', 'HEAD^{tree}'),
          },
        );
      }
      await f.recovery.checkRewriteRepair(
        f.podId,
        repair.id,
        {
          rewriteId: f.rewriteId,
          failedDispatchId: f.dispatchId,
          expectedGeneration: f.pod().lifecycleGeneration,
          expectedResultHash: f.request.expectedResultHash,
          candidateHead: await repairGit(cwd, 'rev-parse', 'HEAD'),
          reason:
            'Select exact repair; no dispatch required for this quiescent provisioning failure fixture',
        },
        f.actor,
      );
      if (kind === 'checked-repair') {
        const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
        vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
          ...(await validate(config)),
          taskReview: {
            status: 'pass',
            reasoning: 'Fixture independent review',
            issues: [],
            model: 'fixture',
            screenshots: [],
          },
        }));
        await f.manager.processPod(f.podId);
        expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
        expect(f.ctx.podRepo.retainedCheckpoints!.latest(f.podId)?.checked?.source).toBeDefined();
      } else {
        // No checks/worker have started: model a settled provisioning failure, not a fabricated execution outcome.
        f.ctx.podRepo.retainedCheckpoints!.owned(repair.id, () =>
          f.ctx.podRepo.update(f.podId, {
            status: 'review_required',
            containerId: '22222222-2222-4222-8222-222222222222',
          }),
        );
      }
    }
  }
  f.ctx.db
    .prepare('UPDATE pods SET profile_snapshot=?,output_target=? WHERE id=?')
    .run(JSON.stringify(f.deps.executionForPod(f.pod())), 'pr', f.podId);
  f.worktrees.inspectSource = f.worktrees.inspectSourceAdoption;
  const selected = await f.worktrees.inspectSource!(f.pod().worktreePath!, f.pod().branch);
  const target = {
    repository: f.deps.executionForPod(f.pod()).repoUrl!,
    branch: f.pod().branch,
    baseBranch: 'main',
  };
  const provider = {
    getPrStatus: vi.fn(async () =>
      pendingStatus({
        merged: true,
        open: false,
        sourceTarget: target,
        headSha:
          f.ctx.podRepo.retainedCheckpoints!.latest(f.podId)?.selected?.head ?? selected.commitSha,
      }),
    ),
    verifyMergedSourceAncestry: vi.fn(),
    createPr: vi.fn(),
    mergePr: vi.fn(),
  };
  vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
  const deps = { ...f.deps, eventBus: f.ctx.eventBus, prManagerFactory: () => provider };
  const controller = createRetainedFinalization(deps);
  const request = {
    requestKey: 'source-finalization',
    expectedGeneration: f.pod().lifecycleGeneration,
    expectedBinding: controller.inspectRetainedFinalization(f.podId).binding,
    mode: 'complete-merged' as const,
    reason: 'Observe immutable selected source delivery while retaining all resources',
  };
  return {
    ...f,
    provider,
    selected,
    target,
    controller,
    request,
    submit: () => controller.finalizeRetained(f.podId, request, f.actor),
  };
}
async function checkpoint(
  f: Awaited<ReturnType<typeof fixture>>,
  parent: string | null,
  namespace = f.podId,
) {
  const cwd = f.pod().worktreePath!;
  const head = await repairGit(
    cwd,
    '-c',
    'user.name=Autopod',
    '-c',
    'user.email=autopod@localhost',
    'commit-tree',
    f.selected.treeSha,
    ...(parent ? ['-p', parent] : []),
    '-m',
    'autopod sandbox checkpoint',
  );
  await repairGit(cwd, 'update-ref', `refs/autopod-quarantine/${namespace}/${head}`, head);
  await repairGit(cwd, 'reset', '--hard', head);
  return head;
}

describe('immutable retained source authority', () => {
  it.each([
    'worker',
    'validation',
    'provider',
  ] as const)('refuses persisted unsettled %s ownership without rewriting it', async (kind) => {
    const f = await fixture();
    const pod = f.pod();
    if (kind === 'worker') {
      f.ctx.podRepo.taskExecutions!.beginRun(f.podId, pod.lifecycleGeneration, 91, {
        runtime: pod.runtime,
        model: pod.model,
        providerAccountId: 'fixture-account',
      });
    } else if (kind === 'validation') {
      const retries = f.ctx.podRepo.taskRetries!;
      retries.authorize(
        f.podId,
        'unsettled-checks',
        'Fixture explicit validation admission',
        f.actor,
      );
      const previous = f.ctx.db
        .prepare(
          'SELECT binding_hash FROM task_retry_attempts WHERE pod_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(f.podId) as { binding_hash: string };
      const admitted = retries.admit(
        f.podId,
        pod.lifecycleGeneration,
        { source: null, contract: null, commands: null, environment: null, implementation: null },
        previous.binding_hash,
        [],
      );
      retries.start(admitted.id);
      expect(
        f.ctx.podRepo.validationExecutions!.dispatch(
          pod,
          admitted.id,
          91,
          f.cm.executionResourceScope,
        ),
      ).toBeTruthy();
      retries.finish(admitted.id, 'nonretryable', 10); // Attempt closure alone is not immutable dispatch settlement.
    } else {
      const delivery = f.ctx.podRepo.deliveryLedger!;
      const intent = delivery.reserve({
        podId: f.podId,
        worktreePath: pod.worktreePath!,
        branch: pod.branch,
        baseBranch: 'main',
        task: pod.task,
        profileName: pod.profileName,
        profile: f.deps.executionForPod(pod),
        podModel: pod.model,
        validationResult: pod.lastValidationResult,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        previewUrl: null,
      });
      expect(delivery.claim(intent)).toBe(true);
      delivery.uncertain(intent.id);
    }
    const tables = [
      'task_agent_runs',
      'task_retry_attempts',
      'validation_dispatches',
      'delivery_intents',
    ];
    const evidence = () =>
      tables.map((table) => f.ctx.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = evidence();
    await expect(f.submit()).rejects.toMatchObject({
      code: {
        worker: 'TASK_EXECUTION_UNSETTLED',
        validation: 'VALIDATION_EXECUTION_UNVERIFIED',
        provider: 'SOURCE_DELIVERY_UNSETTLED',
      }[kind],
    });
    expect(evidence()).toEqual(before);
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
  });
  it('refuses a current container claimed by a different persisted task', async () => {
    const f = await fixture();
    const pod = f.pod();
    f.ctx.podRepo.insert({
      id: 'other-task',
      profileName: pod.profileName,
      task: 'Unrelated task',
      status: 'failed',
      model: pod.model,
      runtime: pod.runtime,
      executionTarget: 'sandbox',
      branch: 'other-branch',
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    f.ctx.podRepo.update('other-task', { containerId: pod.containerId });
    await expect(f.submit()).rejects.toThrow(/claimed by another pod/);
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it.each([
    'continuation',
    'rewrite',
    'repair',
  ] as const)('records selected %s A and owned no-op descendant C, while provider proves A', async (kind) => {
    const f = await fixture(kind);
    const observed = await checkpoint(f, f.selected.commitSha);
    const receipt = await f.submit();
    expect(receipt.state).toBe('finalized');
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)?.evidence).toMatchObject({
      anchor: { head: f.selected.commitSha, tree: f.selected.treeSha },
      source: { commitSha: observed },
      lineage: { head: observed, checkpoints: [observed] },
      mergedHeadSha: f.selected.commitSha,
    });
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it.each([
    'continuation',
    'rewrite',
    'repair',
  ] as const)('refuses clean merged B instead of selected %s A', async (kind) => {
    const f = await fixture(kind);
    const cwd = f.pod().worktreePath!;
    await writeFile(path.join(cwd, 'source.ts'), 'unselected clean substitution\n');
    await repairGit(cwd, 'add', 'source.ts');
    await repairGit(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'unselected B',
    );
    const head = await repairGit(cwd, 'rev-parse', 'HEAD');
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({ merged: true, sourceTarget: f.target, headSha: head }),
    );
    await expect(f.submit()).rejects.toThrow(/source changed/i);
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.provider.getPrStatus).not.toHaveBeenCalled();
  });
  it.each([
    'foreign',
    'unrelated',
  ] as const)('rejects same-tree %s checkpoint, even if provider merged it', async (kind) => {
    const f = await fixture();
    const head = await checkpoint(
      f,
      kind === 'unrelated' ? null : f.selected.commitSha,
      kind === 'foreign' ? 'another-pod' : f.podId,
    );
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({ merged: true, sourceTarget: f.target, headSha: head }),
    );
    await expect(f.submit()).rejects.toThrow(/checkpoint lineage/i);
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)).toBeNull();
  });
  it.each(
    (['continuation', 'rewrite', 'repair'] as const).flatMap((kind) =>
      (['path', 'generation'] as const).map((field) => ({ kind, field })),
    ),
  )('rejects stale $kind selected $field even after fresh preview', async ({ kind, field }) => {
    const f = await fixture(kind);
    if (field === 'path')
      f.ctx.db
        .prepare('UPDATE pods SET worktree_path=? WHERE id=?')
        .run(path.join(f.root, 'stale-original'), f.podId);
    else
      f.ctx.db
        .prepare('UPDATE pods SET lifecycle_generation=lifecycle_generation+1 WHERE id=?')
        .run(f.podId);
    let previewAllowed = false;
    try {
      const view = f.controller.inspectRetainedFinalization(f.podId);
      f.request.expectedBinding = view.binding;
      f.request.expectedGeneration = view.generation;
      previewAllowed = view.canCompleteMerged;
    } catch {
      /* Corrupt repair projections fail closed even at preview. */
    }
    expect(previewAllowed).toBe(false);
    await expect(f.submit()).rejects.toThrow();
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('retains all older owner locations and resources, not just the latest or a capped history page', async () => {
    const f = await fixture();
    const latest = f.ctx.podRepo.approvalRewrites!.latest(f.pod())!;
    for (let n = 1; n <= 55; n++) {
      const binding = {
        ...latest.binding,
        worktreePath: path.join(f.root, `historical-${n}`),
        containerId: `historical-container-${n}`,
        root: path.join(f.root, `rewrite-history-${n}`),
      };
      f.ctx.db
        .prepare(
          'INSERT INTO approval_source_rewrites(rowid,id,pod_id,generation,binding,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          -n,
          `historical-owner-${n}`,
          f.podId,
          1,
          JSON.stringify(binding),
          new Date().toISOString(),
        );
    }
    f.request.expectedBinding = f.controller.inspectRetainedFinalization(f.podId).binding;
    expect((await f.submit()).state).toBe('finalized');
    const held = f.ctx.podRepo.retainedFinalizations!.get(f.podId)!.binding;
    for (let n = 1; n <= 55; n++) {
      expect(held.resources).toContain(`historical-container-${n}`);
      expect(held.sourceLocations).toContain(path.join(f.root, `historical-${n}`));
      expect(held.sourceLocations).toContain(path.join(f.root, `rewrite-history-${n}`));
    }
    expect(f.ctx.podRepo.approvalRewrites!.latest(f.pod())).toEqual(latest);
  });
  it('completes a genuinely settled, published PR518 repair selection without changing its old evidence', async () => {
    const f = await fixture('checked-repair');
    const before = f.ctx.podRepo.retainedCheckpoints!.latest(f.podId)!;
    const validation = f.pod().lastValidationResult;
    const retries = f.ctx.podRepo.taskRetries!.state(f.podId);
    const executions = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    const starts = vi.mocked(f.cm.start).mock.calls.length;
    const spawns = vi.mocked(f.cm.spawn).mock.calls.length;
    expect((await f.submit()).state).toBe('finalized');
    expect(f.ctx.podRepo.taskRetries!.state(f.podId)).toEqual(retries);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId)).toEqual(executions);
    expect(vi.mocked(f.cm.start).mock.calls).toHaveLength(starts);
    expect(vi.mocked(f.cm.spawn).mock.calls).toHaveLength(spawns);
    expect(f.pod().lastValidationResult).toEqual(validation);
    expect(f.ctx.podRepo.retainedCheckpoints!.latest(f.podId)).toEqual(before);
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)?.evidence).toMatchObject({
      anchor: {
        kind: 'rewrite-repair',
        head: before.selected!.head,
        checkedHead: before.checked!.source!.head,
      },
    });
  });
  it('refuses replacement of the recorded checked repair container even with a refreshed request', async () => {
    const f = await fixture('checked-repair');
    f.ctx.db
      .prepare('UPDATE pods SET container_id=? WHERE id=?')
      .run('33333333-3333-4333-8333-333333333333', f.podId);
    const view = f.controller.inspectRetainedFinalization(f.podId);
    expect(view.canStop).toBe(false);
    f.request.expectedBinding = view.binding;
    await expect(f.submit()).rejects.toThrow(/checked-source snapshot/);
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)).toBeNull();
  });
  it('keeps the original rewrite authoritative while a different repair remains unselected', async () => {
    const f = await fixture('unselected-repair');
    expect((await f.submit()).state).toBe('finalized');
    expect(f.ctx.podRepo.retainedFinalizations!.get(f.podId)?.evidence).toMatchObject({
      anchor: { kind: 'rewrite-selected', head: f.selected.commitSha },
    });
    const repair = f.recovery.list(f.podId)[0]!;
    const held = f.ctx.podRepo.retainedFinalizations!.get(f.podId)!.binding;
    expect(held.sourceLocations).toContain(repair.prepared!.worktree);
    expect(held.sourceLocations).toContain(repair.worktreePath);
  });
});
