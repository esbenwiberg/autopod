import type { Session, SessionStatus, ValidationResult } from '@autopod/shared';
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
import type { SessionRepository } from './session-repository.js';
import { createValidationRepository } from './validation-repository.js';

// Mock fs/promises to control worktree existence checks
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
}));

import { access } from 'node:fs/promises';

const mockedAccess = vi.mocked(access);

function makeSession(overrides: Partial<Session> & { id: string; status: SessionStatus }): Session {
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
  sessionRepo: SessionRepository;
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
    sessionRepo: ctx.sessionRepo,
    eventBus: ctx.eventBus,
    containerManager,
    enqueueSession: (id) => enqueuedSessions.push(id),
    validationRepo,
    logger,
  };

  return {
    deps,
    sessionRepo: ctx.sessionRepo,
    eventBus: ctx.eventBus,
    containerManager,
    enqueuedSessions,
    validationRepo,
  };
}

function makePassingValidationResult(sessionId: string, attempt = 1): ValidationResult {
  return {
    sessionId,
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

function makeFailingValidationResult(sessionId: string, attempt = 1): ValidationResult {
  return {
    sessionId,
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
  it('recovers session with surviving worktree', async () => {
    const { deps, sessionRepo, enqueuedSessions, containerManager } = createReconcilerDeps();

    // Insert a running session with a worktree path
    sessionRepo.insert({
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
    sessionRepo.update('ses-1', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/ses-1',
    });

    // Worktree exists
    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('ses-1');
    expect(result.killed).not.toContain('ses-1');

    // Session should be re-queued
    const session = sessionRepo.getOrThrow('ses-1');
    expect(session.status).toBe('queued');
    expect(session.recoveryWorktreePath).toBe('/tmp/worktree/ses-1');
    expect(session.containerId).toBeNull();

    // Old container should have been killed (best-effort)
    expect(containerManager.kill).toHaveBeenCalledWith('ctr-old');

    // Session should have been enqueued
    expect(enqueuedSessions).toContain('ses-1');
  });

  it('kills session with missing worktree', async () => {
    const { deps, sessionRepo } = createReconcilerDeps();

    sessionRepo.insert({
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
    sessionRepo.update('ses-2', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/ses-2',
    });

    // Worktree does NOT exist
    mockedAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await reconcileLocalSessions(deps);

    expect(result.killed).toContain('ses-2');
    expect(result.recovered).not.toContain('ses-2');

    const session = sessionRepo.getOrThrow('ses-2');
    expect(session.status).toBe('killed');
    expect(session.completedAt).not.toBeNull();
  });

  it('finishes session stuck in killing state', async () => {
    const { deps, sessionRepo } = createReconcilerDeps();

    sessionRepo.insert({
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

    const session = sessionRepo.getOrThrow('ses-3');
    expect(session.status).toBe('killed');
    expect(session.completedAt).not.toBeNull();
  });

  it('skips session in queued state', async () => {
    const { deps, sessionRepo, enqueuedSessions } = createReconcilerDeps();

    sessionRepo.insert({
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
    const session = sessionRepo.getOrThrow('ses-4');
    expect(session.status).toBe('queued');
  });

  it('handles old container kill failure gracefully', async () => {
    const containerManager = createMockContainerManager();
    (containerManager.kill as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('container not found'),
    );

    const { deps, sessionRepo, enqueuedSessions } = createReconcilerDeps({ containerManager });

    sessionRepo.insert({
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
    sessionRepo.update('ses-5', {
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

  it('processes mix of recoverable and unrecoverable sessions', async () => {
    const { deps, sessionRepo } = createReconcilerDeps();

    // Recoverable — worktree exists
    sessionRepo.insert({
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
    sessionRepo.update('mix-1', {
      worktreePath: '/tmp/worktree/mix-1',
      containerId: 'ctr-1',
    });

    // Unrecoverable — worktree gone
    sessionRepo.insert({
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
    sessionRepo.update('mix-2', {
      worktreePath: '/tmp/worktree/mix-2',
      containerId: 'ctr-2',
    });

    // Killing state
    sessionRepo.insert({
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

  it('recovers validating session directly to validated when validation passed and PR exists', async () => {
    const { deps, sessionRepo, enqueuedSessions, containerManager, validationRepo } =
      createReconcilerDeps();

    sessionRepo.insert({
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
    sessionRepo.update('val-1', {
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
    const session = sessionRepo.getOrThrow('val-1');
    expect(session.status).toBe('validated');
    expect(session.containerId).toBeNull();

    // Old container should have been killed
    expect(containerManager.kill).toHaveBeenCalledWith('ctr-old');

    // Must NOT be enqueued — goes straight to validated
    expect(enqueuedSessions).not.toContain('val-1');
  });

  it('re-queues validating session when validation passed but PR not yet created', async () => {
    const { deps, sessionRepo, enqueuedSessions, validationRepo } = createReconcilerDeps();

    sessionRepo.insert({
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
    sessionRepo.update('val-2', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/val-2',
      prUrl: null, // no PR yet — crash happened between validation-pass and PR creation
    });
    validationRepo.insert('val-2', 1, makePassingValidationResult('val-2', 1));

    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    // Falls through to normal re-queue path
    expect(result.recovered).toContain('val-2');
    const session = sessionRepo.getOrThrow('val-2');
    expect(session.status).toBe('queued');
    expect(enqueuedSessions).toContain('val-2');
  });

  it('re-queues validating session when no validation results exist', async () => {
    const { deps, sessionRepo, enqueuedSessions } = createReconcilerDeps();

    sessionRepo.insert({
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
    sessionRepo.update('val-3', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/val-3',
      prUrl: 'https://example.com/pr/43',
    });
    // No validation results inserted — crash happened before validation finished

    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('val-3');
    const session = sessionRepo.getOrThrow('val-3');
    expect(session.status).toBe('queued');
    expect(enqueuedSessions).toContain('val-3');
  });

  it('re-queues validating session when last validation result failed', async () => {
    const { deps, sessionRepo, enqueuedSessions, validationRepo } = createReconcilerDeps();

    sessionRepo.insert({
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
    sessionRepo.update('val-4', {
      containerId: 'ctr-old',
      worktreePath: '/tmp/worktree/val-4',
      prUrl: 'https://example.com/pr/44',
    });
    validationRepo.insert('val-4', 1, makeFailingValidationResult('val-4', 1));

    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toContain('val-4');
    const session = sessionRepo.getOrThrow('val-4');
    expect(session.status).toBe('queued');
    expect(enqueuedSessions).toContain('val-4');
  });

  it('returns empty result when no orphaned sessions exist', async () => {
    const { deps } = createReconcilerDeps();

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).toHaveLength(0);
    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('ignores ACI (non-local) sessions', async () => {
    const { deps, sessionRepo } = createReconcilerDeps();

    sessionRepo.insert({
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

    // Even though worktree "exists", ACI sessions should be ignored
    mockedAccess.mockResolvedValue(undefined);

    const result = await reconcileLocalSessions(deps);

    expect(result.recovered).not.toContain('aci-1');
    expect(result.killed).not.toContain('aci-1');
    expect(result.skipped).not.toContain('aci-1');

    // Session should be untouched
    const session = sessionRepo.getOrThrow('aci-1');
    expect(session.status).toBe('running');
  });

  it('kills session when reconcileSession throws unexpectedly', async () => {
    const { deps, sessionRepo } = createReconcilerDeps();

    sessionRepo.insert({
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
    const session = sessionRepo.getOrThrow('err-1');
    expect(session.status).toBe('killed');
  });
});
