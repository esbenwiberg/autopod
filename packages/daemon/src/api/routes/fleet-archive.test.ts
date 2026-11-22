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

function seed(
  id: string,
  status: PodStatus = 'review_required',
  target: 'local' | 'sandbox' = 'sandbox',
) {
  repo.insert({
    id,
    profileName: 'test',
    task: 'Retained source',
    status,
    model: 'fixture',
    runtime: 'codex',
    executionTarget: target,
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

// Model an archive written by a previous daemon; the current API cannot create one.
function legacyArchive(
  id: string,
  reason = 'Remove blocked task from fleet while retaining original evidence',
) {
  repo.fleetArchives!.archive(id, 'human', reason);
}

it('keeps previously archived unverified validation and custody without cleanup authority', async () => {
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
  legacyArchive('blocked');
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

it('survives repository recreation and restores only fleet visibility', async () => {
  seed('retained');
  legacyArchive('retained');
  const first = db.prepare('SELECT * FROM pod_fleet_archives').get();
  expect(createPodRepository(db).getOrThrow('retained').fleetArchivedAt).toEqual(
    expect.any(String),
  );
  expect(db.prepare('SELECT * FROM pod_fleet_archives').get()).toEqual(first);
  for (let i = 0; i < 2; i++)
    expect((await app.inject({ method: 'DELETE', url: '/pods/retained/archive' })).statusCode).toBe(
      200,
    );
  expect((await app.inject('/pods')).json()).toMatchObject([
    { id: 'retained', fleetArchivedAt: null, status: 'review_required' },
  ]);
  expect(cleanup).not.toHaveBeenCalled();
  expect((await app.inject('/pods?archive=only')).json()).toEqual([]);
});

it('applies visibility before pagination limits, preserving include and only scopes', async () => {
  seed('a');
  seed('b');
  seed('c');
  db.prepare("UPDATE pods SET created_at='2026-11-01 12:00:00'").run();
  legacyArchive('b');
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

it.each([
  'archive',
  'archive-handled-elsewhere',
])('returns explicit retirement to older clients of %s without writing any archive or pod state', async (endpoint) => {
  seed('ordinary', 'failed', 'local');
  seed('legacy');
  legacyArchive('legacy');
  const all = () => [
    db.prepare('SELECT * FROM pods ORDER BY id').all(),
    db.prepare('SELECT * FROM pod_fleet_archives ORDER BY pod_id').all(),
  ];
  const before = all();
  for (const id of ['ordinary', 'legacy', 'missing']) {
    const response = await app.inject({
      method: 'POST',
      url: `/pods/${id}/${endpoint}`,
      payload: { reason: 'Older client requested visibility only', retainResources: true },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: 'FLEET_ARCHIVE_RETIRED' });
  }
  expect(all()).toEqual(before);
  expect(cleanup).not.toHaveBeenCalled();
  expect((await app.inject('/pods?archive=garbage')).statusCode).toBe(400);
});

it('projects actual retained Docker custody independently of failed status', async () => {
  seed('ordinary', 'failed', 'local');
  seed('retained', 'failed', 'local');
  seed('sandbox', 'failed');
  db.prepare(`INSERT INTO retained_checkpoint_recoveries (
    id,pod_id,task_id,generation,container_id,resource_key,worktree_path,request_hash,
    actor,reason,binding,original_evidence,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'checkpoint',
    'retained',
    'fixture-task',
    1,
    'original-id',
    'fixture-key',
    '/retained/retained',
    'request-hash',
    '{}',
    'Legacy held recovery',
    '{}',
    '{}',
    '2026-11-01T00:00:00Z',
  );
  expect((await app.inject('/pods/retained')).json()).toMatchObject({
    retainedDockerCustody: true,
  });
  expect((await app.inject('/pods/ordinary')).json()).toMatchObject({
    retainedDockerCustody: false,
  });
  expect((await app.inject('/pods?compact=true')).json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'ordinary', status: 'failed', retainedDockerCustody: false }),
      expect.objectContaining({ id: 'retained', status: 'failed', retainedDockerCustody: true }),
      expect.objectContaining({ id: 'sandbox', status: 'failed', retainedDockerCustody: false }),
    ]),
  );
});
