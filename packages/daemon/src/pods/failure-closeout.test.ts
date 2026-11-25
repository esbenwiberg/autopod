import type { SystemEvent } from '@autopod/shared';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import { podRoutes } from '../api/routes/pods.js';
import {
  createMockContainerManager,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createFailureCloseout } from './failure-closeout.js';
import type { PodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';

const id = 'failed-pod';
const actor = { type: 'human', userId: 'operator' } as const;
const containerId = 'f'.repeat(64);
const finishedAt = '2026-01-01T00:00:00.000Z';

describe('failure closeout', () => {
  let db: ReturnType<typeof createTestDb>;
  let pods: ReturnType<typeof createPodRepository>;
  let events: SystemEvent[];
  let observe: ReturnType<typeof vi.fn>;
  let idle: boolean;
  let close: ReturnType<typeof createFailureCloseout>;

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db, { name: 'test-profile' });
    pods = createPodRepository(db);
    const common = {
      profileName: 'test-profile',
      task: 'Example',
      model: 'test',
      runtime: 'claude' as const,
      executionTarget: 'local' as const,
      branch: 'test',
      userId: actor.userId,
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr' as const,
    };
    pods.insert({ ...common, id, status: 'failed' });
    pods.insert({ ...common, id: 'dependent', status: 'queued', dependsOnPodId: id });
    pods.update(id, {
      failureReason: 'Build failed',
      completedAt: finishedAt,
      containerId,
      worktreePath: '/saved/worktree',
    });
    const eventBus = createEventBus(createEventRepository(db), pino({ level: 'silent' }));
    events = [];
    eventBus.subscribe((event) => events.push(event));
    observe = vi.fn().mockResolvedValue(true);
    idle = true;
    close = createFailureCloseout({
      pods,
      eventBus,
      manager: () => ({ ...createMockContainerManager(), isPodExecutionStopped: observe }),
      isIdle: () => idle,
      isGoal: () => false,
    });
  });

  afterEach(() => db.close());

  it('records only closeout, leaves dependents and resources unchanged and survives restart/history', async () => {
    const before = pods.getOrThrow(id);
    const receipt = await close(id, before.updatedAt, actor);
    expect(receipt.failureClosedAt).toBeTruthy();
    expect(observe).toHaveBeenCalledWith(id, containerId);
    expect(pods.getOrThrow(id)).toMatchObject({
      status: 'failed',
      failureReason: before.failureReason,
      completedAt: finishedAt,
      containerId,
      worktreePath: '/saved/worktree',
      failureClosedAt: receipt.failureClosedAt,
    });
    expect(pods.getOrThrow('dependent').status).toBe('queued');
    expect(events).toEqual([
      expect.objectContaining({ type: 'pod.failure_closed', userId: actor.userId, podId: id }),
    ]);
    await expect(close(id, before.updatedAt, actor)).resolves.toEqual(receipt);
    expect(events).toHaveLength(1);
    expect(observe).toHaveBeenCalledTimes(1);
    const reopened = createPodRepository(db);
    expect(reopened.listCompactForDisplay?.().find((pod) => pod.id === id)?.failureClosedAt).toBe(
      receipt.failureClosedAt,
    );
    expect(reopened.getForHistory?.(id).failureClosedAt).toBe(receipt.failureClosedAt);
    reopened.delete(id);
    expect(reopened.getForHistory?.(id)).toMatchObject({
      status: 'failed',
      failureClosedAt: receipt.failureClosedAt,
    });
  });

  it('does not close an active, unresolved, or unobservable failure', async () => {
    const before = pods.getOrThrow(id);
    idle = false;
    await expect(close(id, before.updatedAt, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(observe).not.toHaveBeenCalled();
    idle = true;

    const journal = pods.sandboxWakeups;
    if (!journal) throw new Error('Missing sandbox wakeup journal');
    const key = 'https://example.invalid/exact-resource';
    journal.observeRunning(key, 'sandbox');
    const intent = journal.claim(key, 'sandbox', id);
    journal.beginDispatch(intent.id);
    await expect(close(id, before.updatedAt, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(observe).not.toHaveBeenCalled();
    expect(pods.getOrThrow(id).failureClosedAt).toBeNull();
    expect(events).toEqual([]);
  });

  it('keeps a failed pod visible when a recorded container create has no settled identity', async () => {
    const scope = pods.retainedAllocations?.scope(id);
    if (!scope) throw new Error('Missing allocation scope');
    scope.begin('container', 'autopod-failed-pod');
    await expect(close(id, pods.getOrThrow(id).updatedAt, actor)).rejects.toMatchObject({
      code: 'FAILURE_CLOSEOUT_BLOCKED',
    });
    expect(observe).not.toHaveBeenCalled();
    expect(pods.getOrThrow(id).failureClosedAt).toBeNull();
  });

  it('rejects execution observation failures and rechecks around the provider await', async () => {
    const before = pods.getOrThrow(id);
    observe.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(close(id, before.updatedAt, actor)).rejects.toMatchObject({ statusCode: 409 });
    observe.mockResolvedValueOnce(false);
    await expect(close(id, before.updatedAt, actor)).rejects.toMatchObject({ statusCode: 409 });
    observe.mockImplementationOnce(async () => {
      pods.update(id, { status: 'queued' });
      return true;
    });
    await expect(close(id, before.updatedAt, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(pods.getOrThrow(id).failureClosedAt).toBeNull();
    expect(events).toEqual([]);
  });

  it('does not apply a closeout to a later failure, even in the same generation', async () => {
    const before = pods.getOrThrow(id);
    await close(id, before.updatedAt, actor);
    pods.update(id, { status: 'running' });
    pods.update(id, { status: 'failed', failureReason: 'Retry failed' });
    expect(pods.getOrThrow(id)).toMatchObject({
      lifecycleGeneration: before.lifecycleGeneration,
      failureClosedAt: null,
    });
  });

  it('reopens attention if a different execution resource is attached', async () => {
    await close(id, pods.getOrThrow(id).updatedAt, actor);
    pods.update(id, { containerId: 'c'.repeat(64) });
    expect(pods.getOrThrow(id)).toMatchObject({ status: 'failed', failureClosedAt: null });
  });

  it('requires a delegated human and exposes the unchanged failed outcome in compact reads', async () => {
    const app = Fastify();
    const manager = {
      closeFailure: close,
      listSessions: () => pods.list(),
    } as unknown as PodManager;
    app.setErrorHandler(errorHandler);
    app.addHook('preHandler', async (request) => {
      request.user = {
        oid: 'authenticated-identity',
        name: 'Operator',
        preferred_username: 'operator@example.invalid',
        roles: [],
        iss: 'fixture',
        aud: 'fixture',
        iat: 1,
        exp: 2,
        ...(request.headers.authorization === 'Bearer delegated'
          ? { operatorPrincipal: 'delegated-user' as const }
          : {}),
      };
    });
    podRoutes(app, manager, undefined, undefined, pods);
    try {
      const request = { method: 'POST' as const, url: `/pods/${id}/close-failure` };
      const payload = { expectedUpdatedAt: pods.getOrThrow(id).updatedAt };
      const headers = { authorization: 'Bearer delegated' };
      expect((await app.inject({ ...request, payload })).statusCode).toBe(401);
      expect(
        (await app.inject({ ...request, headers, payload: { ...payload, actor } })).statusCode,
      ).toBe(400);
      expect(observe).not.toHaveBeenCalled();
      const result = await app.inject({ ...request, headers, payload });
      expect(result.statusCode).toBe(200);
      const compact = await app.inject({ url: '/pods?compact=true', headers });
      expect(compact.statusCode).toBe(200);
      expect(compact.json()).toContainEqual(
        expect.objectContaining({
          id,
          status: 'failed',
          failureClosedAt: result.json().failureClosedAt,
        }),
      );
      expect(events[0]).toMatchObject({ userId: 'authenticated-identity' });
    } finally {
      await app.close();
    }
  });

  it('rejects non-human actors and stale revisions before observing the backend', async () => {
    const before = pods.getOrThrow(id);
    await expect(
      close(id, before.updatedAt, { type: 'automation', id: 'auto' }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(close(id, 'stale', actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(observe).not.toHaveBeenCalled();
  });
});
