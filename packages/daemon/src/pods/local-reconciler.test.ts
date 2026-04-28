import type { Pod, PodStatus, ValidationResult } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  createMockContainerManager,
  createTestContext,
  logger,
} from '../test-utils/mock-helpers.js';
import type { EventBus } from './event-bus.js';
import {
  type LocalReconcilerDependencies,
  type ReconcileResult,
  reconcileLocalSessions,
} from './local-reconciler.js';
import type { PodRepository } from './pod-repository.js';
import { createValidationRepository } from './validation-repository.js';

// Mock fs/promises to control worktree existence checks
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
}));

import { access } from 'node:fs/promises';

const mockedAccess = vi.mocked(access);

function makeSession(overrides: Partial<Pod> & { id: string; status: PodStatus }): Pod {
  return {
    profileName: 'test-profile',
    task: 'Test task',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/test',
    containerId: 'ctr-old',
    worktreePath: '/tmp/worktree/test',
    validationAttempts: 0,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    updatedAt: new Date().toISOString(),
    userId: 'user-1',
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    previewUrl: null,
    prUrl: null,
    plan: null,
    progress: null,
    acceptanceCriteria: null,
    claudeSessionId: null,
    outputMode: 'pr',
    baseBranch: null,
    acFrom: null,
    recoveryWorktreePath: null,
    ...overrides,
  };
}

function createReconcilerDeps(overrides?: {
  containerManager?: ContainerManager;
}): {
  deps: LocalReconcilerDependencies;
  podRepo: PodRepository;
  eventBus: EventBus;
  containerManager: ContainerManager;
  enqueuedSessions: string[];
  validationRepo: ReturnType<typeof createValidationRepository>;
} {
  const ctx = createTestContext();
  const containerManager = overrides?.containerManager ?? createMockContainerManager();
  const enqueuedSessions: string[] = [];
  const validationRepo = createValidationRepository(ctx.db);

  const deps: LocalReconcilerDependencies = {
    podRepo: ctx.podRepo,
    eventBus: ctx.eventBus,
    containerManager,
    enqueueSession: (id) => enqueuedSessions.push(id),
    validationRepo,
    logger,
  };

  return {
    deps,
    podRepo: ctx.podRepo,
    eventBus: ctx.eventBus,
    containerManager,
    enqueuedSessions,
    validationRepo,
  };
}

function makePassingValidationResult(podId: string, attempt = 1): ValidationResult {
  return {
    podId,
    attempt,
    timestamp: new Date().toISOString(),
    overall: 'pass',
    duration: 1000,
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: { status: 'pass', url: 'http://localhost', responseCode: 200, duration: 50 },
      pages: [],
    },
    taskReview: null,
  };
}

function makeFailingValidationResult(podId: string, attempt = 1): ValidationResult {
  return {
    podId,
    attempt,
    timestamp: new Date().toISOString(),
    overall: 'fail',
    duration: 1000,
    smoke: {
      status: 'fail',
      build: { status: 'fail', output: 'error', duration: 100 },
      health: { status: 'fail', url: 'http://localhost', responseCode: null, duration: 50 },
      pages: [],
    },
    taskReview: null,
  };
}

describe('reconcileLocalSessions', () => {
  it('recovers pod with surviving worktree', async () => {
    const { deps, podRepo, enqueuedSessions, containerManager } = createReconcilerDeps();

    // Insert a running pod with a worktree path
    podRepo.insert({
      id: 'ses-1',
      profileName: 'test-profile',
      task: 'Add feature',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/ses-1',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('ses-1', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/ses-1',
    });

    // Worktree exists
    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('ses-1');
    expect(result.killed).not.toContain('ses-1');

    // Pod should be re-queued with counter reset
    const pod = podRepo.getOrThrow('ses-1');
    expect(pod.status).toBe('queued');
    expect(pod.recoveryWorktreePath).toBe('/tmp/worktree/ses-1');
    expect(pod.containerId).toBeNull();
    expect(pod.validationAttempts).toBe(0);

    // Old container should have been killed (best-effort)
    expect(containerManager.kill).toHaveBeenCalledWith('ctr-old');

    // Pod should have been enqueued
    expect(enqueuedSessions).toContain('ses-1');
  });

  it('resets validationAttempts to 0 when recovering a pod that had exhausted its attempts', async () => {
    const { deps, podRepo } = createReconcilerDeps();

    podRepo.insert({
      id: 'ses-exhausted',
      profileName: 'test-profile',
      task: 'Add feature',
      status: 'validating',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/ses-exhausted',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('ses-exhausted', {
      containerId: 'ctr-exhausted',
      worktreePath: '/tmp/worktree/ses-exhausted',
      validationAttempts: 3,
    });

    mockedAccess.mockResolvedValue(undefined);

    await reconcileLocalSessions(deps);

    const pod = podRepo.getOrThrow('ses-exhausted');
    // Without the fix, validationAttempts stays 3, next run computes attempt=4 → "4 of 3"
    expect(pod.validationAttempts).toBe(0);
    expect(pod.status).toBe('queued');
  });

  it('kills pod with missing worktree', async () => {
    const { deps, podRepo } = createReconcilerDeps();

    podRepo.insert({
      id: 'ses-2',
      profileName: 'test-profile',
      task: 'Add feature',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/ses-2',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('ses-2', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/ses-2',
    });

    // Worktree does NOT exist
    mockedAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await reconcileLocalSessions(deps);

    expect(result.killed).toContain('ses-2');
    expect(result.recovered).not.toContain('ses-2');

    const pod = podRepo.getOrThrow('ses-2');
    expect(pod.status).toBe('killed');
    expect(pod.completedAt).not.toBeNull();
  });

  it('re-queues interactive pod with no worktree for fresh re-provision', async () => {
    const stoppedContainerManager = createMockContainerManager();
    vi.mocked(stoppedContainerManager.getStatus).mockResolvedValue('stopped');
    const { deps, podRepo, enqueuedSessions } = createReconcilerDeps({
      containerManager: stoppedContainerManager,
    });

    podRepo.insert({
      id: 'int-1',
      profileName: 'test-profile',
      task: 'Workspace task',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/int-1',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'workspace',
      options: { agentMode: 'interactive', output: 'branch', validate: false, promotable: true },
      baseBranch: null,
      acFrom: null,
    });
    // No worktreePath — interactive pod that was killed/restarted before worktree was created
    podRepo.update('int-1', { containerId: 'ctr-old' });

    // Worktree does NOT exist
    mockedAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await reconcileLocalSessions(deps);

    // Should be re-queued, NOT killed
    expect(result.recovered).toContain('int-1');
    expect(result.killed).not.toContain('int-1');

    const pod = podRepo.getOrThrow('int-1');
    expect(pod.status).toBe('queued');
    expect(enqueuedSessions).toContain('int-1');
    expect(pod.recoveryWorktreePath).toBeNull();
  });

  it('restores workspace pod in-place when its container is still running after daemon restart', async () => {
    // Default mock returns 'running' for getStatus — simulates container surviving daemon restart
    const { deps, podRepo, containerManager, enqueuedSessions } = createReconcilerDeps();

    podRepo.insert({
      id: 'ws-alive',
      profileName: 'test-profile',
      task: 'Workspace task',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/ws-alive',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'workspace',
      options: { agentMode: 'interactive', output: 'branch', validate: false, promotable: true },
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('ws-alive', {
      containerId: 'ctr-alive',
      worktreePath: '/tmp/worktree/ws-alive',
    });

    const result = await reconcileLocalSessions(deps);

    // Container still alive — should be restored, never re-queued or killed
    expect(result.recovered).toContain('ws-alive');
    expect(result.killed).not.toContain('ws-alive');
    expect(enqueuedSessions).not.toContain('ws-alive');
    expect(vi.mocked(containerManager.kill)).not.toHaveBeenCalledWith('ctr-alive');

    const pod = podRepo.getOrThrow('ws-alive');
    expect(pod.status).toBe('running');
    expect(pod.containerId).toBe('ctr-alive');
  });

  it('finishes pod stuck in killing state', async () => {
    const { deps, podRepo } = createReconcilerDeps();

    podRepo.insert({
      id: 'ses-3',
      profileName: 'test-profile',
      task: 'Some task',
      status: 'killing',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/ses-3',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });

    const result = await reconcileLocalSessions(deps);

    expect(result.killed).toContain('ses-3');
    expect(result.recovered).not.toContain('ses-3');

    const pod = podRepo.getOrThrow('ses-3');
    expect(pod.status).toBe('killed');
    expect(pod.completedAt).not.toBeNull();
  });

  it('skips pod in queued state', async () => {
    const { deps, podRepo, enqueuedSessions } = createReconcilerDeps();

    podRepo.insert({
      id: 'ses-4',
      profileName: 'test-profile',
      task: 'Queued task',
      status: 'queued',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/ses-4',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });

    const result = await reconcileLocalSessions(deps);

    expect(result.skipped).toContain('ses-4');
    expect(result.recovered).not.toContain('ses-4');
    expect(result.killed).not.toContain('ses-4');

    // Should NOT have been re-enqueued by the reconciler
    expect(enqueuedSessions).not.toContain('ses-4');

    // Status unchanged
    const pod = podRepo.getOrThrow('ses-4');
    expect(pod.status).toBe('queued');
  });

  it('handles old container kill failure gracefully', async () => {
    const containerManager = createMockContainerManager();
    (containerManager.kill as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('container not found'),
    );

    const { deps, podRepo, enqueuedSessions } = createReconcilerDeps({ containerManager });

    podRepo.insert({
      id: 'ses-5',
      profileName: 'test-profile',
      task: 'Recover me',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/ses-5',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('ses-5', {
      containerId: 'ctr-gone',
      worktreePath: '/tmp/worktree/ses-5',
    });

    // Worktree exists
    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    // Should still recover despite container kill failure
    expect(result.recovered).toContain('ses-5');
    expect(enqueuedSessions).toContain('ses-5');
  });

  it('processes mix of recoverable and unrecoverable pods', async () => {
    const { deps, podRepo } = createReconcilerDeps();

    // Recoverable — worktree exists
    podRepo.insert({
      id: 'mix-1',
      profileName: 'test-profile',
      task: 'Recoverable',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/mix-1',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('mix-1', {
      worktreePath: '/tmp/worktree/mix-1',
      containerId: 'ctr-1',
    });

    // Unrecoverable — worktree gone
    podRepo.insert({
      id: 'mix-2',
      profileName: 'test-profile',
      task: 'Unrecoverable',
      status: 'provisioning',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/mix-2',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('mix-2', {
      worktreePath: '/tmp/worktree/mix-2',
      containerId: 'ctr-2',
    });

    // Killing state
    podRepo.insert({
      id: 'mix-3',
      profileName: 'test-profile',
      task: 'Killing',
      status: 'killing',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/mix-3',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });

    // Mock access: mix-1 exists, mix-2 does not
    mockedAccess.mockImplementation(async (p) => {
      if (String(p).includes('mix-1')) return undefined;
      throw new Error('ENOENT');
    });

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('mix-1');
    expect(result.killed).toContain('mix-2');
    expect(result.killed).toContain('mix-3');
  });

  it('recovers validating pod directly to validated when validation passed and PR exists', async () => {
    const { deps, podRepo, enqueuedSessions, containerManager, validationRepo } =
      createReconcilerDeps();

    podRepo.insert({
      id: 'val-1',
      profileName: 'test-profile',
      task: 'Fix task',
      status: 'validating',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/val-1',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('val-1', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/val-1',
      prUrl: 'https://example.com/pr/42',
    });
    validationRepo.insert('val-1', 1, makePassingValidationResult('val-1', 1));

    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('val-1');
    expect(result.killed).not.toContain('val-1');

    // Should be validated, NOT re-queued
    const pod = podRepo.getOrThrow('val-1');
    expect(pod.status).toBe('validated');
    expect(pod.containerId).toBeNull();

    // Old container should have been killed
    expect(containerManager.kill).toHaveBeenCalledWith('ctr-old');

    // Must NOT be enqueued — goes straight to validated
    expect(enqueuedSessions).not.toContain('val-1');
  });

  it('re-queues validating pod when validation passed but PR not yet created', async () => {
    const { deps, podRepo, enqueuedSessions, validationRepo } = createReconcilerDeps();

    podRepo.insert({
      id: 'val-2',
      profileName: 'test-profile',
      task: 'Fix task',
      status: 'validating',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/val-2',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('val-2', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/val-2',
      prUrl: null, // no PR yet — crash happened between validation-pass and PR creation
    });
    validationRepo.insert('val-2', 1, makePassingValidationResult('val-2', 1));

    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    // Falls through to normal re-queue path
    expect(result.recovered).toContain('val-2');
    const pod = podRepo.getOrThrow('val-2');
    expect(pod.status).toBe('queued');
    expect(enqueuedSessions).toContain('val-2');
  });

  it('re-queues validating pod when no validation results exist', async () => {
    const { deps, podRepo, enqueuedSessions } = createReconcilerDeps();

    podRepo.insert({
      id: 'val-3',
      profileName: 'test-profile',
      task: 'Fix task',
      status: 'validating',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/val-3',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('val-3', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/val-3',
      prUrl: 'https://example.com/pr/43',
    });
    // No validation results inserted — crash happened before validation finished

    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('val-3');
    const pod = podRepo.getOrThrow('val-3');
    expect(pod.status).toBe('queued');
    expect(enqueuedSessions).toContain('val-3');
  });

  it('re-queues validating pod when last validation result failed', async () => {
    const { deps, podRepo, enqueuedSessions, validationRepo } = createReconcilerDeps();

    podRepo.insert({
      id: 'val-4',
      profileName: 'test-profile',
      task: 'Fix task',
      status: 'validating',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/val-4',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    podRepo.update('val-4', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/val-4',
      prUrl: 'https://example.com/pr/44',
    });
    validationRepo.insert('val-4', 1, makeFailingValidationResult('val-4', 1));

    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('val-4');
    const pod = podRepo.getOrThrow('val-4');
    expect(pod.status).toBe('queued');
    expect(enqueuedSessions).toContain('val-4');
  });

  it('returns empty result when no orphaned pods exist', async () => {
    const { deps } = createReconcilerDeps();

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toHaveLength(0);
    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('ignores ACI (non-local) pods', async () => {
    const { deps, podRepo } = createReconcilerDeps();

    podRepo.insert({
      id: 'aci-1',
      profileName: 'test-profile',
      task: 'ACI task',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'aci',
      branch: 'autopod/aci-1',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });

    // Even though worktree "exists", ACI pods should be ignored
    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).not.toContain('aci-1');
    expect(result.killed).not.toContain('aci-1');
    expect(result.skipped).not.toContain('aci-1');

    // Pod should be untouched
    const pod = podRepo.getOrThrow('aci-1');
    expect(pod.status).toBe('running');
  });

  it('kills pod when reconcileSession throws unexpectedly', async () => {
    const { deps, podRepo } = createReconcilerDeps();

    podRepo.insert({
      id: 'err-1',
      profileName: 'test-profile',
      task: 'Error task',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/err-1',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      acceptanceCriteria: null,
      outputMode: 'pr',
      baseBranch: null,
      acFrom: null,
    });
    // No worktreePath, no containerId — access will still be called on null
    // which should trigger the "worktree missing" path → killed

    mockedAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await reconcileLocalSessions(deps);

    expect(result.killed).toContain('err-1');
    const pod = podRepo.getOrThrow('err-1');
    expect(pod.status).toBe('killed');
  });
});
