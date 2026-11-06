import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OperatorActor } from '@autopod/shared';
import { vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { resolveLaunchExecutionSettings } from '../configuration/launch-execution-settings.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createCompletionEvents } from '../pods/completion-events.js';
import { createPodManager } from '../pods/pod-manager.js';
import { createRetainedCheckpointRecovery } from '../pods/retained-checkpoint-recovery.js';
import { checkpointHash } from '../pods/retained-checkpoint-repository.js';
import { resolveReviewerModel, resolveReviewerProvider } from '../pods/runtime-resolver.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { IsolatedReviewer } from '../validation/isolated-reviewer.js';
import { ReviewerRunRepository } from '../validation/reviewer-run-repository.js';
import { checkpointSandboxWorkspace } from '../worktrees/sandbox-workspace-checkpoint.js';
import { createTestConfiguration, testExecutionCapabilities } from './configuration-helpers.js';
import {
  createFailingValidationResult,
  createMockContainerManager,
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
  // Execute the maintained checkpoint shell/bundle/import implementation against
  // a local guest clone. Only the provider transport is replaced, not its Git semantics.
  vi.mocked(f.ctx.deps.sandboxWorkspaceCheckpoint!).mockImplementation(async (args) => {
    const guest = await mkdtemp(path.join(f.root, 'guest-'));
    await git(f.root, 'clone', '--no-local', '--branch', f.pod().branch, args.worktreePath, guest);
    const cm = createMockContainerManager();
    cm.execInContainer = vi.fn(async (_id, command) => {
      const [program, ...argv] = command;
      if (!program) throw new Error('Missing checkpoint command');
      const result = await exec(
        program,
        argv.map((arg) => arg.replace('cd /workspace', `cd ${guest}`)),
        {
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        },
      );
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    });
    cm.readFile = vi.fn(async (_id, remote) => readFile(remote, 'utf8'));
    cm.readFileBinary = vi.fn(async (_id, remote) => readFile(remote));
    try {
      return await checkpointSandboxWorkspace({ ...args, containerManager: cm });
    } finally {
      await rm(guest, { recursive: true, force: true });
    }
  });
  f.cm.getStatus = vi.fn(async (id) => (id === f.containerId ? 'stopped' : 'running'));
  Object.assign(f.cm, {
    executionResourceScope:
      'https://management.example.invalid/subscriptions/test/resourcegroups/test/sandboxgroups/test',
  });
  vi.mocked(f.cm.spawn).mockResolvedValue('22222222-2222-4222-8222-222222222222');
  vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => {
    // Real report files exercise the post-check Git cleanliness and custody gates.
    // Neither incident requires its repository to already ignore daemon evidence.
    for (const folder of ['evidence/fixture', 'screenshots']) {
      const directory = path.join(config.worktreePath, '.autopod', folder);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'fixture-report.txt'), 'Fresh generated evidence\n');
    }
    return createPassingValidationResult(config.podId, config.attempt);
  });
  vi.mocked(f.cm.extractDirectoryFromContainer!).mockImplementation(async (_id, _remote, local) => {
    await mkdir(local, { recursive: true });
    await cp(path.join(f.pod().worktreePath!, '.autopod'), path.join(local, '.autopod'), {
      recursive: true,
    });
    await writeFile(
      path.join(local, 'fresh-validation-report.txt'),
      'New sandbox validation reports\n',
    );
  });
}

/** A settled worker reported infrastructure before any validation result existed. */
export async function preValidationCheckpointFixture() {
  return recordPreValidationInfrastructure(await retainedCheckpointFixture());
}

export function recordPreValidationInfrastructure(
  f: Awaited<ReturnType<typeof retainedCheckpointFixture>>,
) {
  f.ctx.podRepo.update(f.podId, { status: 'failed', lastValidationResult: null });
  const journal = f.ctx.podRepo.completionJournal;
  if (!journal) throw new Error('Missing completion journal fixture');
  journal.settle(f.pod(), 'Implementation preserved; runner unavailable');
  journal.mark(f.pod(), 'ready', true);
  const report = {
    id: 'prevalidation-infrastructure',
    podId: f.podId,
    type: 'report_blocker' as const,
    timestamp: '2026-11-06T12:00:00.000Z',
    response: null,
    payload: {
      kind: 'infrastructure' as const,
      lifecycleGeneration: f.pod().lifecycleGeneration,
      requiresResponse: false,
      owner: 'validation' as const,
      phase: 'Native desktop verification',
      description: 'Worker cannot run native Mac checks',
      attempted: ['Configured Linux worker'],
      needs: 'Qualified verification of the preserved candidate',
    },
  };
  f.ctx.escalationRepo.insert(report);
  const originalReport = f.ctx.escalationRepo.getOrThrow(report.id);
  const infrastructureReports = [
    { id: report.id, timestamp: originalReport.createdAt, payload: report.payload },
  ];
  f.input.expectedResultHash = checkpointHash({ result: null, infrastructureReports });
  f.worktrees.selectRetainedContinuationSource = vi.fn(async () => ({
    head: f.prepared.head,
    tree: f.prepared.tree,
    baseCommitSha: '1'.repeat(40),
  }));
  return { ...f, report, originalReport, infrastructureReports };
}

/** Exercise a real replacement dispatch and published failure, then model the
 * old final-source comparator rejecting a daemon-only no-op capture.
 */
export async function blockedCheckpointOutcomeFixture(
  f: Awaited<ReturnType<typeof retainedCheckpointFixture>>,
) {
  vi.stubEnv('DATA_DIR', f.root);
  f.ctx.podRepo.update(f.podId, { maxValidationAttempts: f.pod().validationAttempts + 1 });
  await materializeCheckpointFixture(f);
  vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) =>
    createFailingValidationResult(config.podId, config.attempt),
  );
  if (f.result.overall === 'fail')
    f.ctx.podRepo.taskRetries!.authorize(
      f.podId,
      'replacement-checks',
      'Authorize one selected-checkpoint validation while retaining original evidence',
      f.actor,
    );
  await f.submit();
  await f.recovery.wait(f.input.id);
  const inspect = f.worktrees.inspectSourceAdoption.getMockImplementation()!;
  let classifyOldFailure = true;
  f.worktrees.inspectSourceAdoption.mockImplementation(async (cwd, branch) => {
    const source = await inspect(cwd, branch);
    return classifyOldFailure && f.pod().status === 'review_required'
      ? { ...source, treeSha: '0'.repeat(40) }
      : source;
  });
  try {
    await f.manager.processPod(f.podId);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'CHECKPOINT_SOURCE_CHANGED'
    )
      throw error;
  } finally {
    classifyOldFailure = false;
  }
  const source = await inspect(f.pod().worktreePath!, f.pod().branch);
  return {
    expectedGeneration: f.pod().lifecycleGeneration,
    expectedResultHash: checkpointHash(f.pod().lastValidationResult),
    expectedHead: source.commitSha,
    reason:
      'Observe the already-published failed checks after exact owned no-op checkpoint verification',
  };
}

export async function retainedCheckpointFixture(
  kind: 'validation' | 'wakeup' = 'validation',
  native = false,
  independentReview = false,
  executionRequirements?: import('@autopod/shared').ExecutionRequirements,
) {
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
  const nativeConfiguration = native ? createTestConfiguration(ctx.db) : null;
  const snapshots = nativeConfiguration
    ? createLaunchSnapshotRepository(ctx.db, nativeConfiguration.store)
    : null;
  if (nativeConfiguration && snapshots) {
    if (independentReview) {
      const flow = nativeConfiguration.store.get('workflow', 'flow');
      nativeConfiguration.store.write({
        id: flow.id,
        kind: 'workflow',
        name: flow.name,
        expectedRevision: flow.revision,
        payload: { ...flow.payload, validationPhases: ['build', 'test', 'review'] },
      });
    }
    vi.mocked(nativeConfiguration.services.executionCapabilities).mockResolvedValue({
      ...testExecutionCapabilities,
      target: 'sandbox',
    });
    const accounts = createProviderAccountStore(ctx.db);
    accounts.create({
      id: 'account',
      name: 'Fixture account',
      provider: 'anthropic',
      credentials: { provider: 'anthropic', apiKey: 'fixture-main' },
    });
    vi.mocked(nativeConfiguration.services.resolveAgentRoute).mockImplementation(async (route) =>
      resolveLaunchAgentRoute(route, accounts),
    );
    ctx.deps.providerAccountStore = accounts;
    ctx.deps.launchConfiguration = {
      read: snapshots.get,
      reviewer: new IsolatedReviewer({
        runs: new ReviewerRunRepository(ctx.db),
        accounts,
        logger: ctx.deps.logger,
        manager: () => ctx.containerManager,
        image: () => 'fixture.azurecr.io/reviewer:retained',
        readPod: (id) => ctx.podRepo.getOrThrow(id),
        assertAllowed: vi.fn(async () => {}),
      }),
      executionSettings: (config) =>
        resolveLaunchExecutionSettings(config, { image: config.resolvedEnvironment.pinnedBase }),
      assertCurrentCapabilities: vi.fn(async () => {}),
      prepareEnvironment: vi.fn(async () => 'fixture.azurecr.io/autopod:retained'),
    };
  }
  const manager = createPodManager(ctx.deps);
  const task = 'Recover retained source through real checks';
  const nativeAdmission =
    nativeConfiguration && snapshots
      ? await admitLaunch({
          request: {
            repositoryId: 'repo-a',
            profileId: 'profile',
            task,
            ...(executionRequirements
              ? {
                  work: {
                    contract: {
                      contractVersion: 1 as const,
                      title: 'Retained typed launcher task',
                      dependsOn: [],
                      scenarios: [],
                      requiredFacts: [],
                      humanReview: [],
                      executionRequirements,
                    },
                  },
                }
              : {}),
            overrides: { execution: { target: 'sandbox' } },
          },
          actorId: 'operator',
          services: nativeConfiguration.services,
          snapshots,
          createPod: (config) => manager.createResolvedSession(config, 'operator').id,
        })
      : null;
  const created = nativeAdmission
    ? ctx.podRepo.getOrThrow(nativeAdmission.podId)
    : manager.createSession({ profileName: 'test-profile', task }, 'operator');
  // macOS temporary directories may be reached through /var or /tmp aliases.
  // Fixtures must bind canonical storage without weakening production alias guards.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'checkpoint-controller-')));
  const profile =
    nativeAdmission && ctx.deps.launchConfiguration
      ? ctx.deps.launchConfiguration.executionSettings(nativeAdmission.config)
      : ctx.profileStore.get(created.profileName);
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
      : createPassingValidationResult(created.id, native ? 2 : 1);
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
    validationAttempts: native ? (kind === 'validation' ? 0 : 2) : 1,
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
