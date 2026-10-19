import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OperatorActor, Pod, ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockProfileStore,
  createMockWorktreeManager,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { findingId } from '../validation/finding-fingerprint.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createNudgeRepository } from './nudge-repository.js';
import { createPendingOverrideRepository } from './pending-override-repository.js';
import { createPodRepository } from './pod-repository.js';
import { validateTransition } from './state-machine.js';
import { ValidationSupersededError } from './validation-ownership.js';
import { createValidationWorkflowControls } from './validation-workflow-controls.js';
import type {
  ValidationWorkflowCalls,
  ValidationWorkflowDependencies,
  ValidationWorkflowLiveDependencies,
} from './validation-workflow-ports.js';
import { createValidationWorkflowState } from './validation-workflow-state.js';
const logger = pino({ level: 'silent' });
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function result(): ValidationResult {
  return {
    podId: 'controls',
    attempt: 1,
    timestamp: '2026-10-18T12:00:00Z',
    overall: 'fail',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: 'http://fixture', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: {
      status: 'fail',
      reasoning: 'Review',
      issues: ['Review finding'],
      model: 'test-model',
      diff: '',
      screenshots: [],
    },
    duration: 2,
  };
}
function fixture(status: Pod['status'] = 'validating', persistent = false) {
  const seed = createTestDb();
  insertTestProfile(seed);
  let db: Database.Database = seed;
  let file: string | undefined;
  let root: string | undefined;
  if (persistent) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-controls-'));
    file = path.join(root, 'state.db');
    fs.writeFileSync(file, seed.serialize());
    seed.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
  }
  cleanup.push(() => {
    db.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  const podRepo = createPodRepository(db);
  podRepo.insert({
    id: 'controls',
    profileName: 'test-profile',
    task: 'Validation controls',
    status,
    runtime: 'claude',
    model: 'test-model',
    executionTarget: 'local',
    branch: 'autopod/controls',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  podRepo.update('controls', {
    containerId: 'controls-container',
    worktreePath: '/tmp/controls',
    lastValidationResult: result(),
  });
  const state = createValidationWorkflowState();
  const pending = createPendingOverrideRepository(db);
  const escalationRepo = createEscalationRepository(db);
  const nudgeRepo = createNudgeRepository(db);
  const worktree = createMockWorktreeManager();
  const transition: ValidationWorkflowDependencies['transition'] = vi.fn((pod, to, extra) => {
    validateTransition(pod.id, pod.status, to);
    podRepo.update(pod.id, { status: to, ...extra });
    return podRepo.getOrThrow(pod.id);
  });
  const waiver = {
    waivedAt: '2026-10-18T12:00:00Z',
    waivedBy: 'human',
    actor: { type: 'human' as const, userId: 'operator' },
    reason: 'Controlled waiver builder result',
    attempt: 1,
    failedPhases: ['review'],
    failedFactIds: [],
  };
  const buildWaiver = vi.fn<ValidationWorkflowDependencies['buildValidationWaiver']>(() => waiver);
  const deps: ValidationWorkflowLiveDependencies = { pendingOverrideRepo: pending };
  const dependent = vi.fn();
  const assertStopped = vi.fn();
  const captured: Parameters<typeof createValidationWorkflowControls>[1] = {
    ...state,
    forceWithLeaseAllowances: new Set(),
    podRepo,
    escalationRepo,
    nudgeRepo,
    worktreeManager: worktree,
    logger,
    executionForPod: () => createMockProfileStore(db).get('test-profile'),
    resolveGitCredential: async () => 'synthetic-git-token',
    assertExecutionTerminationVerified: assertStopped,
    actorLabel: (actor) =>
      actor.type === 'human'
        ? actor.userId
        : actor.type === 'automation'
          ? actor.id
          : actor.decisionId,
    legacyRespondedBy: (actor) => (actor.type === 'human' ? 'human' : 'ai'),
    buildValidationWaiver: buildWaiver,
    mergeOverrides: (a, b) => [...a, ...b],
    transition,
    emitActivityStatus: vi.fn(),
    maybeTriggerDependents: dependent,
  };
  const owner = createValidationWorkflowControls(deps, captured);
  return {
    db,
    podRepo,
    pending,
    escalationRepo,
    nudgeRepo,
    worktree,
    state,
    deps,
    captured,
    owner,
    waiver,
    buildWaiver,
    dependent,
    assertStopped,
    pod: () => podRepo.getOrThrow('controls'),
    reopen() {
      if (!file) throw new Error('Not persistent');
      const originalRows = {
        pods: db.prepare('SELECT * FROM pods').all(),
        overrides: db.prepare('SELECT * FROM pending_validation_overrides').all(),
        escalations: db.prepare('SELECT * FROM escalations').all(),
      };
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect({
        pods: db.prepare('SELECT * FROM pods').all(),
        overrides: db.prepare('SELECT * FROM pending_validation_overrides').all(),
        escalations: db.prepare('SELECT * FROM escalations').all(),
      }).toEqual(originalRows);
      return {
        pod: createPodRepository(db).getOrThrow('controls'),
        pending: createPendingOverrideRepository(db).list('controls'),
        escalations: createEscalationRepository(db).listBySession('controls'),
      };
    },
  };
}
describe('validation workflow controls', () => {
  it('constructs inertly and shares its abort registry with the existing consumers', () => {
    const f = fixture();
    expect(f.assertStopped).not.toHaveBeenCalled();
    const controller = new AbortController();
    const ownership = f.owner.claimValidation(f.pod(), controller);
    expect(f.state.validationAbortControllers.get('controls')).toBe(controller);
    f.owner.interruptValidation('controls');
    expect(controller.signal.aborted).toBe(true);
    expect(ownership.isCurrent()).toBe(true);
  });
  it('retains a replacement controller and fences the old claim', () => {
    const f = fixture();
    const first = new AbortController();
    const old = f.owner.claimValidation(f.pod(), first);
    expect(() => f.owner.claimValidation(f.pod(), new AbortController())).toThrow(
      ValidationSupersededError,
    );
    const replacement = new AbortController();
    f.state.validationAbortControllers.set('controls', replacement);
    expect(old.isCurrent()).toBe(false);
    f.owner.interruptValidation('controls');
    expect(replacement.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });
  it('retains pending human decisions and refuses a validation claim', () => {
    const f = fixture();
    f.nudgeRepo.queue('controls', 'Human instruction');
    expect(() => f.owner.claimValidation(f.pod(), new AbortController())).toThrow(
      ValidationSupersededError,
    );
    expect(f.state.validationAbortControllers.size).toBe(0);
    expect(f.nudgeRepo.hasPending('controls')).toBe(true);
  });
  it('checks execution termination before writing the controller registry', () => {
    const f = fixture();
    const error = new Error('Unverified');
    f.assertStopped.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => f.owner.claimValidation(f.pod(), new AbortController())).toThrow(error);
    expect(f.state.validationAbortControllers.size).toBe(0);
  });
  it('queues update-from-base and aborts exactly the current validation controller', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.state.validationAbortControllers.set('controls', controller);
    const trigger = vi.fn();
    expect(await f.owner.updateFromBase.call({ triggerValidation: trigger }, 'controls')).toEqual({
      ok: true,
      action: 'queued_after_abort',
    });
    expect(controller.signal.aborted).toBe(true);
    expect(f.state.pendingUpdateFromBaseIntents.has('controls')).toBe(true);
    expect(f.worktree.rebaseOntoBase).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });
  it.each(['clean', 'unchanged', 'conflict'] as const)(
    'unwinds a queued rebase after abort (%s)',
    async (kind) => {
      const f = fixture();
      vi.mocked(f.worktree.rebaseOntoBase).mockResolvedValueOnce({
        rebased: kind === 'clean',
        alreadyUpToDate: kind === 'unchanged',
        conflicts: kind === 'conflict' ? ['file.ts'] : [],
      });
      const follow = vi.fn();
      await f.owner.runUpdateFromBaseAfterAbort('controls', follow);
      expect(f.pod().status).toBe(kind === 'conflict' ? 'review_required' : 'failed');
      expect(follow).toHaveBeenCalledTimes(kind === 'clean' ? 1 : 0);
      expect(f.captured.forceWithLeaseAllowances.has('controls')).toBe(kind === 'clean');
    },
  );
  it('keeps an accepted extension coalesced until its current receiver finishes', async () => {
    const f = fixture('review_required');
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const trigger = vi.fn(() => held);
    const calls: Pick<ValidationWorkflowCalls, 'triggerValidation'> = {
      triggerValidation: trigger,
    };
    try {
      await f.owner.extendAttempts.call(calls, 'controls', 1);
      await f.owner.extendAttempts.call(calls, 'controls', 1);
      expect(f.pod().maxValidationAttempts).toBe(4);
      expect(trigger).toHaveBeenCalledOnce();
      expect(f.state.attemptExtensionRuns.has('controls')).toBe(true);
    } finally {
      release();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(f.state.attemptExtensionRuns.has('controls')).toBe(false);
  });
  it.each([
    ['running', 1],
    ['review_required', 8],
  ] as const)('rejects extension for %s and delta %s before dispatch', async (status, delta) => {
    const f = fixture(status);
    const trigger = vi.fn();
    await expect(
      f.owner.extendAttempts.call({ triggerValidation: trigger }, 'controls', delta),
    ).rejects.toMatchObject({ code: status === 'running' ? 'INVALID_STATE' : 'VALIDATION_ERROR' });
    expect(trigger).not.toHaveBeenCalled();
    expect(f.pod().maxValidationAttempts).toBe(3);
  });
  it('re-evaluates real queued dismissals against cached validation without engine dispatch', async () => {
    const f = fixture('review_required');
    f.pending.enqueue('controls', {
      findingId: findingId('task_review', 'Review finding'),
      description: 'Review finding',
      action: 'dismiss',
      reason: 'Reviewed',
    });
    expect(await f.owner.applyOverridesInstant('controls')).toEqual({ advanced: true });
    expect(f.pod().status).toBe('validated');
    expect(f.pod().lastValidationResult?.overall).toBe('pass');
    expect(f.pending.list('controls')).toEqual([]);
    expect(f.pod().validationOverrides).toHaveLength(1);
  });
  it('uses the live pending-override service and retains caller-owned dependencies captured once', async () => {
    const f = fixture('review_required');
    const flush = vi.fn(() => []);
    f.deps.pendingOverrideRepo = { flush };
    await expect(f.owner.applyOverridesInstant('controls')).resolves.toEqual({ advanced: false });
    expect(flush).toHaveBeenCalledWith('controls');
    f.captured.assertExecutionTerminationVerified = () => {
      throw new Error('Replacement wrapper');
    };
    f.podRepo.update('controls', { status: 'validating' });
    f.owner.claimValidation(f.pod(), new AbortController());
    expect(f.assertStopped).toHaveBeenCalledOnce();
  });
  it('applies a failed skip decision using the supplied actor/waiver and consumes its pending base-update intent', () => {
    const f = fixture();
    const actor: OperatorActor = { type: 'human', userId: 'operator' };
    f.podRepo.update('controls', { skipValidation: true, skipValidationActor: actor });
    f.state.pendingUpdateFromBaseIntents.add('controls');
    const input = f.pod().lastValidationResult;
    if (!input) throw new Error('Missing result');
    const pod = f.owner.applySkipValidationDecision(f.pod(), input);
    expect(f.buildWaiver).toHaveBeenCalledWith(input, 'Validation skipped by operator', actor);
    expect(pod?.validationWaiver).toEqual(f.waiver);
    expect(pod?.status).toBe('validated');
    expect(f.state.pendingUpdateFromBaseIntents.has('controls')).toBe(false);
  });
  it('resolves a real recurring-finding escalation with actor provenance and preserves its waiver through reopen', () => {
    const f = fixture('awaiting_input', true);
    const escalation = {
      id: 'override',
      podId: 'controls',
      type: 'validation_override' as const,
      timestamp: '2026-10-18T12:00:00Z',
      payload: { findings: [], attempt: 1, maxAttempts: 3 },
      response: null,
    };
    f.escalationRepo.insert(escalation);
    f.podRepo.update('controls', { pendingEscalation: escalation });
    const actor: OperatorActor = { type: 'human', userId: 'operator' };
    f.owner.setSkipValidation('controls', true, actor);
    expect(f.dependent).toHaveBeenCalledOnce();
    const reopened = f.reopen();
    expect(reopened.pod).toMatchObject({
      status: 'validated',
      pendingEscalation: null,
      skipValidation: true,
      skipValidationActor: actor,
      validationWaiver: f.waiver,
    });
    expect(reopened.escalations[0]?.response).toMatchObject({ respondedBy: 'human', actor });
  });
  it('flushes persisted pending overrides and retains the advanced cached result through reopen', async () => {
    const f = fixture('review_required', true);
    f.pending.enqueue('controls', {
      findingId: findingId('task_review', 'Review finding'),
      description: 'Review finding',
      action: 'dismiss',
    });
    await f.owner.applyOverridesInstant('controls');
    const reopened = f.reopen();
    expect(reopened.pending).toEqual([]);
    expect(reopened.pod.status).toBe('validated');
    expect(reopened.pod.lastValidationResult?.taskReview?.issues).toEqual([]);
    expect(reopened.pod.validationOverrides).toHaveLength(1);
  });
});
