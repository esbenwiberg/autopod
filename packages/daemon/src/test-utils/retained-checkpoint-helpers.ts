import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OperatorActor } from '@autopod/shared';
import { vi } from 'vitest';
import { createCompletionEvents } from '../pods/completion-events.js';
import { createPodManager } from '../pods/pod-manager.js';
import { createRetainedCheckpointRecovery } from '../pods/retained-checkpoint-recovery.js';
import { checkpointHash } from '../pods/retained-checkpoint-repository.js';
import { resolveReviewerModel, resolveReviewerProvider } from '../pods/runtime-resolver.js';
import {
  createFailingValidationResult,
  createPassingValidationResult,
  createTestContext,
} from './mock-helpers.js';

const exec = promisify(execFile);
export async function materializeCheckpointFixture(
  f: Awaited<ReturnType<typeof retainedCheckpointFixture>>,
) {
  const source = f.pod().worktreePath!;
  await mkdir(source, { recursive: true });
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec('git', args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })
    ).stdout.trim();
  await git(source, 'init', '-b', f.pod().branch);
  await writeFile(path.join(source, 'source.ts'), 'export const preserved = true;\n');
  await writeFile(path.join(source, '.gitignore'), 'ignored-report.txt\n');
  await git(source, 'add', '.');
  await git(
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'retained checkpoint',
  );
  await writeFile(
    path.join(source, 'ignored-report.txt'),
    'Original report must survive independently\n',
  );
  f.input.checkpointHead = await git(source, 'rev-parse', 'HEAD');
  f.worktrees.inspectSourceAdoption.mockImplementation(async (cwd, branch) => ({
    branch,
    commitSha: await git(cwd, 'rev-parse', 'HEAD'),
    treeSha: await git(cwd, 'rev-parse', 'HEAD^{tree}'),
    worktreeClean: (await git(cwd, 'status', '--porcelain')).length === 0,
  }));
  f.deps.prepare = undefined; // Real independent archive/bundle/worktree, not an injected receipt.
  f.cm.getStatus = vi.fn(async (id) => (id === f.containerId ? 'stopped' : 'running'));
  Object.assign(f.cm, {
    executionResourceScope:
      'https://management.example.invalid/subscriptions/test/resourcegroups/test/sandboxgroups/test',
  });
  vi.mocked(f.cm.spawn).mockResolvedValue('22222222-2222-4222-8222-222222222222');
  vi.mocked(f.cm.extractDirectoryFromContainer!).mockImplementation(async (_id, _remote, local) => {
    await mkdir(local, { recursive: true });
    await writeFile(
      path.join(local, 'fresh-validation-report.txt'),
      'New sandbox validation reports\n',
    );
  });
}

export async function retainedCheckpointFixture(kind: 'validation' | 'wakeup' = 'validation') {
  const ctx = createTestContext();
  vi.mocked(ctx.profileStore.get).mockReturnValue({
    ...ctx.profileStore.get('test-profile'),
    warmImageTag: 'fixture.azurecr.io/autopod:retained',
  });
  // Mock only provider checkpoint transport; source selection and independent Git preparation stay real in lifecycle tests.
  ctx.deps.sandboxWorkspaceCheckpoint = vi.fn(async (args) => {
    args.assertCurrent?.();
    const source = await ctx.worktreeManager.inspectSourceAdoption!(
      args.worktreePath,
      ctx.podRepo.getOrThrow(args.podId).branch,
    );
    return {
      sequence: args.sequence,
      sourceHead: source.commitSha,
      sourceTree: source.treeSha,
      snapshotCommit: source.commitSha,
      snapshotTree: source.treeSha,
      transferVerified: true,
      bundleVerified: true,
      hostImported: true,
      lineageVerified: true,
      promoted: true,
      materialized: true,
      quarantineRef: 'refs/autopod/test-checkpoint',
    };
  });
  const manager = createPodManager(ctx.deps);
  const created = manager.createSession(
    { profileName: 'test-profile', task: 'Recover retained source through real checks' },
    'operator',
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-controller-'));
  const profile = ctx.profileStore.get(created.profileName);
  const retryBinding = checkpointHash({
    runtime: created.runtime,
    model: created.model,
    provider: created.providerIdSnapshot,
    account: created.providerAccountIdSnapshot,
    reviewerModel: resolveReviewerModel(profile),
    reviewerProvider: resolveReviewerProvider(profile),
  });
  const previousAdmission = ctx.podRepo.taskRetries!.admit(
    created.id,
    created.lifecycleGeneration,
    { source: null, contract: null, commands: null, environment: null, implementation: null },
    retryBinding,
    [],
  );
  ctx.podRepo.taskRetries!.start(previousAdmission.id);
  ctx.podRepo.taskRetries!.finish(
    previousAdmission.id,
    kind === 'validation' ? 'nonretryable' : 'pass',
    302000,
  );
  const result =
    kind === 'validation'
      ? createFailingValidationResult(created.id)
      : createPassingValidationResult(created.id);
  if (kind === 'validation')
    result.infrastructureFailure = {
      phase: 'setup',
      code: 'EXEC_EXIT_UNVERIFIED',
      statusCode: 409,
      message: 'Original buffered response missing',
      retryable: false,
    };
  const containerId = '9d1515b6-2ea6-4fde-8641-2723925d014a';
  const resourceKey = `https://management.swedencentral.azuredevcompute.io/subscriptions/test/resourcegroups/test/sandboxgroups/test/sandboxes/${containerId}`;
  ctx.podRepo.update(created.id, {
    status: kind === 'validation' ? 'review_required' : 'validated',
    executionTarget: 'sandbox',
    containerId,
    worktreePath: path.join(root, 'original'),
    lastValidationResult: result,
    validationAttempts: 1,
    options: { ...created.options, validationSuite: 'custom', validate: true },
    autoApprove: false,
  });
  const wakeups = ctx.podRepo.sandboxWakeups!;
  if (kind === 'wakeup') {
    wakeups.observeRunning(resourceKey, containerId);
    wakeups.beginDispatch(wakeups.claim(resourceKey, containerId, created.id).id);
  }
  const cm = Object.assign(ctx.containerManager, {
    getResourceKey: vi.fn(async () => resourceKey),
  });
  vi.mocked(cm.getStatus).mockResolvedValue('stopped');
  const head = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const worktrees = Object.assign(ctx.worktreeManager, {
    inspectSourceAdoption: vi.fn(async (_cwd: string, branch: string) => ({
      branch,
      commitSha: head,
      treeSha: tree,
      worktreeClean: true,
    })),
  });
  const prepared = {
    worktree: path.join(root, 'new-worktree'),
    bare: path.join(root, 'repository.git'),
    snapshot: path.join(root, 'host-snapshot'),
    bundle: path.join(root, 'source.bundle'),
    bundleHash: 'c'.repeat(64),
    head,
    tree,
    hostInventoryHash: 'd'.repeat(64),
  };
  const deps: Parameters<typeof createRetainedCheckpointRecovery>[0] = {
    podRepo: ctx.podRepo,
    executionForPod: () => profile,
    getContainerManager: () => cm,
    worktreeManager: worktrees,
    isIdle: vi.fn(() => true),
    isGoal: vi.fn(() => false),
    assertGuidanceCollected: vi.fn(),
    enqueue: vi.fn(),
    transition: createCompletionEvents({
      podRepo: ctx.podRepo,
      eventBus: ctx.eventBus,
      bumpActivityTimestamp: vi.fn(),
      recordNotReportedMemoryUsage: vi.fn(),
      refreshReadiness: vi.fn(),
    }).transition,
    emit: vi.fn(),
    root,
    logger: { error: vi.fn() },
    prepare: vi.fn(async () => prepared),
  };
  const recovery = createRetainedCheckpointRecovery(deps);
  const pod = () => ctx.podRepo.getOrThrow(created.id);
  const input = {
    id: 'recovery-fixture',
    expectedGeneration: pod().lifecycleGeneration,
    expectedResultHash: checkpointHash(result),
    checkpointHead: head,
    reason: 'Select preserved source for fresh isolated validation; retain original evidence',
  };
  const actor: OperatorActor = { type: 'human', userId: 'operator' };
  return {
    ctx,
    manager,
    root,
    result,
    containerId,
    resourceKey,
    cm,
    worktrees,
    prepared,
    deps,
    recovery,
    pod,
    input,
    actor,
    podId: created.id,
    submit: () => recovery.submit(created.id, input, actor),
  };
}
