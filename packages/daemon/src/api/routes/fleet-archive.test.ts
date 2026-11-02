import type { PodStatus } from '@autopod/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { PodManager } from '../../pods/index.js';
import { createPodRepository } from '../../pods/pod-repository.js';
import { assertValidationMutationSettled } from '../../pods/validation-recovery-policy.js';
import {
  createPassingValidationResult,
  createTestDb,
  insertTestProfile,
} from '../../test-utils/mock-helpers.js';
import { podRoutes } from './pods.js';

let db: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createPodRepository>;
let app: FastifyInstance;
const cleanup = vi.fn();

function seed(id: string, status: PodStatus = 'review_required') {
  repo.insert({
    id,
    profileName: 'test',
    task: 'Retained source',
    status,
    model: 'fixture',
    runtime: 'codex',
    executionTarget: 'sandbox',
    branch: `ap/${id}`,
    userId: 'human',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update(id, { containerId: `sandbox-${id}`, worktreePath: `/retained/${id}` });
}

beforeEach(async () => {
  db = createTestDb();
  insertTestProfile(db, { name: 'test' });
  repo = createPodRepository(db);
  cleanup.mockReset();
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.user = { oid: 'human', name: 'Operator' } as typeof request.user;
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    reply
      .code(error instanceof ZodError ? 400 : (e.statusCode ?? 500))
      .send({ error: e.message, code: e.code });
  });
  const manager = {
    getSession: (id: string) => repo.getOrThrow(id),
    listSessions: repo.list,
    deleteSession: async (id: string) => {
      assertValidationMutationSettled(repo, id);
      cleanup();
    },
  } as unknown as PodManager;
  podRoutes(app, manager, undefined, undefined, repo);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

async function archive(
  id: string,
  reason = 'Remove blocked task from fleet while retaining original evidence',
) {
  return app.inject({
    method: 'POST',
    url: `/pods/${id}/archive`,
    payload: { reason, retainResources: true },
  });
}

it('archives an unverified validation without changing lifecycle, source, reports, custody or cleanup authority', async () => {
  seed('blocked');
  const result = createPassingValidationResult();
  result.overall = 'fail';
  result.infrastructureFailure = {
    phase: 'test',
    code: 'EXEC_EXIT_UNVERIFIED',
    message: 'cleanup failed',
    retryable: false,
    execution: { cause: 'timeout', timeoutMs: 900000, cleanup: 'failed' },
  };
  repo.update('blocked', { lastValidationResult: result });
  const before = db.prepare('SELECT * FROM pods WHERE id=?').get('blocked');
  expect((await archive('blocked')).statusCode).toBe(200);
  expect(db.prepare('SELECT * FROM pods WHERE id=?').get('blocked')).toEqual(before);
  expect(repo.getOrThrow('blocked').fleetArchivedAt).toEqual(expect.any(String));
  expect(repo.list().map((p) => p.id)).toContain('blocked'); // internal execution/retention reads
  expect(repo.listNonTerminalPodIds()).toContain('blocked');
  expect(repo.listReferencedContainerIds()).toContain('sandbox-blocked');
  expect(() => assertValidationMutationSettled(repo, 'blocked')).toThrow(
    /termination is unverified/,
  );
  const deleted = await app.inject({ method: 'DELETE', url: '/pods/blocked' });
  expect(deleted.statusCode).toBe(409);
  expect(cleanup).not.toHaveBeenCalled();
  expect((await app.inject('/pods')).json()).toEqual([]);
  expect((await app.inject('/pods?compact=true')).json()).toEqual([]);
  expect((await app.inject('/pods?archive=only')).json()).toMatchObject([{ id: 'blocked' }]);
  expect((await app.inject('/pods/blocked')).json()).toMatchObject({
    id: 'blocked',
    status: 'review_required',
    fleetArchivedAt: expect.any(String),
    lastValidationResult: JSON.parse(JSON.stringify(result)),
  });
  expect((await app.inject('/pods?compact=true&archive=include')).json()).toMatchObject([
    { id: 'blocked', fleetArchivedAt: expect.any(String) },
  ]);
  expect(db.prepare('SELECT actor_id, reason FROM pod_fleet_archives').get()).toMatchObject({
    actor_id: 'human',
    reason: expect.stringContaining('retaining original evidence'),
  });
});

it('is idempotent, survives repository recreation, and restores only fleet visibility', async () => {
  seed('retained');
  await archive('retained');
  const first = db.prepare('SELECT * FROM pod_fleet_archives').get();
  await archive('retained', 'Repeated request must not replace original audit metadata');
  expect(db.prepare('SELECT * FROM pod_fleet_archives').get()).toEqual(first);
  expect(createPodRepository(db).getOrThrow('retained').fleetArchivedAt).toEqual(
    expect.any(String),
  );
  for (let i = 0; i < 2; i++)
    expect((await app.inject({ method: 'DELETE', url: '/pods/retained/archive' })).statusCode).toBe(
      200,
    );
  expect((await app.inject('/pods')).json()).toMatchObject([
    { id: 'retained', fleetArchivedAt: null, status: 'review_required' },
  ]);
  expect(cleanup).not.toHaveBeenCalled();
  await archive('retained');
  expect((await app.inject('/pods?archive=only')).json()).toHaveLength(1);
});

it('applies visibility before pagination limits, preserving include and only scopes', async () => {
  seed('a');
  seed('b');
  seed('c');
  db.prepare("UPDATE pods SET created_at='2026-11-01 12:00:00'").run();
  await archive('b');
  const page = (await app.inject('/pods?compact=true&page=true&limit=1')).json();
  expect(page.pods.map((p: { id: string }) => p.id)).toEqual(['c']);
  const next = (
    await app.inject(`/pods?compact=true&page=true&limit=1&cursor=${page.nextCursor}`)
  ).json();
  expect(next.pods.map((p: { id: string }) => p.id)).toEqual(['a']);
  expect(next.nextCursor).toBeNull();
  expect(
    (await app.inject('/pods?compact=true&page=true&limit=1&archive=only')).json(),
  ).toMatchObject({ pods: [{ id: 'b' }], nextCursor: null });
  expect((await app.inject('/pods?archive=include')).json()).toHaveLength(3);
});

it.each<PodStatus>([
  'queued',
  'provisioning',
  'running',
  'validating',
  'approved',
  'merging',
  'paused',
  'killing',
])('refuses archive in active state %s', async (status) => {
  seed('active', status);
  expect((await archive('active')).statusCode).toBe(409);
  expect(repo.fleetArchives?.archivedAt('active')).toBeNull();
});

it('requires explicit resource-retention acknowledgement and a meaningful human reason', async () => {
  seed('retained');
  for (const payload of [
    { reason: 'x', retainResources: true },
    { reason: 'Meaningful operator reason' },
    { reason: 'Meaningful operator reason', retainResources: false },
  ]) {
    expect(
      (await app.inject({ method: 'POST', url: '/pods/retained/archive', payload })).statusCode,
    ).toBe(400);
  }
  expect((await archive('missing')).statusCode).toBe(404);
  expect((await app.inject('/pods?archive=garbage')).statusCode).toBe(400);
  expect(repo.fleetArchives?.archivedAt('retained')).toBeNull();
});
