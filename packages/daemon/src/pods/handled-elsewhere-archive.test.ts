import { access } from 'node:fs/promises';
import type { HandledElsewhereArchiveRequest, PodStatus } from '@autopod/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { podRoutes } from '../api/routes/pods.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { reconcileLocalSessions } from './local-reconciler.js';
import type { PodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';
import { reconcileSandboxSessions } from './reconciler.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: vi.fn(async () => {}),
}));

let db: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createPodRepository>;
let app: FastifyInstance;
const effects = vi.fn();
const input: HandledElsewhereArchiveRequest = {
  expectedGeneration: 1,
  expectedStatus: 'validated',
  reason: 'Work delivered manually; retain unknown native delivery and all original evidence',
  reference: 'https://github.com/example/repo/pull/1',
  retainResources: true,
  acknowledgement: 'visibility-only-unknown-execution-retained',
};
function seed(id: string, status: PodStatus = 'validated', target: 'local' | 'sandbox' = 'local') {
  repo.insert({
    id,
    profileName: 'test',
    task: 'Saved source',
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
  repo.update(id, {
    containerId: 'a'.repeat(64),
    worktreePath: `/retained/${id}`,
    ...(status === 'paused' ? { pauseReason: 'manual' as const } : {}),
  });
}
function retainedTables() {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='pod_fleet_archives' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    ]),
  );
}
const seedLegacyArchive = (id: string, body = input) =>
  repo.fleetArchives!.archiveHandledElsewhere(id, 'human', body);
beforeEach(async () => {
  db = createTestDb();
  insertTestProfile(db, { name: 'test' });
  repo = createPodRepository(db);
  effects.mockReset();
  vi.mocked(access).mockReset().mockResolvedValue(undefined);
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.user = { oid: 'human', name: 'Operator' } as typeof request.user;
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    reply.code(error instanceof ZodError ? 400 : (e.statusCode ?? 500)).send({ error: e.message });
  });
  podRoutes(
    app,
    {
      getSession: repo.getOrThrow,
      listSessions: repo.list,
      deleteSession: effects,
      killSession: effects,
      resumePod: effects,
      approveSession: effects,
    } as unknown as PodManager,
    undefined,
    undefined,
    repo,
  );
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

it('archives missing-receipt external delivery without altering ANY native evidence table', async () => {
  seed('delivered');
  repo.update('delivered', {
    failureReason: 'Confirmed source publication unavailable; resources retained',
  });
  const before = retainedTables();
  seedLegacyArchive('delivered');
  expect(retainedTables()).toEqual(before);
  expect(repo.getOrThrow('delivered')).toMatchObject({
    status: 'validated',
    containerId: 'a'.repeat(64),
    fleetArchivedAt: expect.any(String),
    failureReason: expect.stringContaining('publication unavailable'),
  });
  const audit = db
    .prepare('SELECT actor_id,reason FROM pod_fleet_archives WHERE pod_id=?')
    .get('delivered') as { actor_id: string; reason: string };
  expect(audit.actor_id).toBe('human');
  expect(JSON.parse(audit.reason)).toMatchObject({
    kind: 'handled-elsewhere-visibility-v1',
    generation: 1,
    status: 'validated',
    reference: input.reference,
  });
  expect((await app.inject('/pods')).json()).toEqual([]);
  expect((await app.inject('/pods?archive=only')).json()).toMatchObject([
    { id: 'delivered', status: 'validated' },
  ]);
  expect(effects).not.toHaveBeenCalled();
});

it('retains a paused unknown worker and restores visibility without resuming or reconciling usage', async () => {
  seed('paused', 'paused');
  repo.taskExecutions!.beginRun('paused', 1, 1, {
    runtime: 'codex',
    model: 'fixture',
    providerAccountId: null,
    resource: { containerId: 'a'.repeat(64), executionTarget: 'local' },
  });
  const before = retainedTables();
  expect(repo.taskExecutions!.hasActiveRun('paused')).toBe(true);
  seedLegacyArchive('paused', { ...input, expectedStatus: 'paused' });
  expect((await app.inject({ method: 'DELETE', url: '/pods/paused/archive' })).statusCode).toBe(
    200,
  );
  expect(repo.getOrThrow('paused')).toMatchObject({
    status: 'paused',
    pauseReason: 'manual',
    fleetArchivedAt: null,
  });
  expect(retainedTables()).toEqual(before);
  expect(repo.taskExecutions!.hasActiveRun('paused')).toBe(true);
  expect(effects).not.toHaveBeenCalled();
});

it.each([
  'local',
  'sandbox',
] as const)('restart does not wake, stop, clean or mutate explicit manual pauses (%s)', async (target) => {
  seed('paused', 'paused', target);
  const before = retainedTables();
  const cm = { getStatus: effects, stop: effects, start: effects, remove: effects };
  if (target === 'local') {
    const result = await reconcileLocalSessions({
      podRepo: repo,
      logger,
      containerManager: cm,
      enqueueSession: effects,
    } as unknown as Parameters<typeof reconcileLocalSessions>[0]);
    expect(result).toEqual({ recovered: [], killed: [], skipped: ['paused'] });
  } else {
    await reconcileSandboxSessions({
      podRepo: repo,
      logger,
      sandboxContainerManager: cm,
      preserveWorkspace: effects,
      quiesceSandboxAgent: effects,
      suspendSandbox: effects,
      enqueueSession: effects,
    } as unknown as Parameters<typeof reconcileSandboxSessions>[0]);
  }
  expect(effects).not.toHaveBeenCalled();
  expect(retainedTables()).toEqual(before);
});

it.each([
  'local',
  'sandbox',
] as const)('rechecks a concurrent pause/archive before further recovery effects (%s)', async (target) => {
  seed('race', 'running', target);
  const dispose = async () => {
    repo.update('race', { status: 'paused', pauseReason: 'manual' });
    seedLegacyArchive('race', { ...input, expectedStatus: 'paused' });
  };
  const getStatus = vi.fn(async () => {
    await dispose();
    return 'running';
  });
  if (target === 'local') {
    vi.mocked(access).mockImplementationOnce(dispose);
    const result = await reconcileLocalSessions({
      podRepo: repo,
      logger,
      containerManager: { getStatus, kill: effects },
      enqueueSession: effects,
      cleanupPodResources: effects,
    } as unknown as Parameters<typeof reconcileLocalSessions>[0]);
    expect(result).toEqual({ recovered: [], killed: [], skipped: ['race'] });
    expect(getStatus).not.toHaveBeenCalled();
  } else {
    await reconcileSandboxSessions({
      podRepo: repo,
      logger,
      sandboxContainerManager: { getStatus, start: effects },
      preserveWorkspace: effects,
      quiesceSandboxAgent: effects,
      suspendSandbox: effects,
      enqueueSession: effects,
    } as unknown as Parameters<typeof reconcileSandboxSessions>[0]);
  }
  expect(effects).not.toHaveBeenCalled();
  expect(repo.getOrThrow('race')).toMatchObject({
    status: 'paused',
    pauseReason: 'manual',
    containerId: 'a'.repeat(64),
    recoveryCount: 0,
  });
  expect(repo.fleetArchives!.archivedAt('race')).toBeTruthy();
});

it('does not manufacture a manual pause when automatic sandbox observation is unavailable', async () => {
  seed('auto', 'running', 'sandbox');
  const getStatus = vi.fn().mockResolvedValueOnce('unknown').mockResolvedValueOnce('running');
  const deps = {
    podRepo: repo,
    logger,
    eventBus: { emit: vi.fn() },
    sandboxContainerManager: { getStatus },
    preserveWorkspace: effects,
    quiesceSandboxAgent: effects,
    suspendSandbox: effects,
    enqueueSession: effects,
  } as unknown as Parameters<typeof reconcileSandboxSessions>[0];
  await reconcileSandboxSessions(deps);
  expect(repo.getOrThrow('auto')).toMatchObject({ status: 'paused', pauseReason: null });
  expect(effects).not.toHaveBeenCalled();
  await reconcileSandboxSessions(deps);
  expect(getStatus).toHaveBeenCalledTimes(2);
  expect(effects).toHaveBeenCalledTimes(3);
  expect(repo.getOrThrow('auto').pauseReason).toBeNull();
});

it('retains ambiguous legacy manual markers without claiming their worker settled', async () => {
  seed('legacy', 'paused', 'sandbox');
  repo.update('legacy', {
    lastRecoveryTrigger: 'restart',
    lastCorrectionMessage: 'Old automatic park',
  });
  const before = retainedTables();
  await reconcileSandboxSessions({
    podRepo: repo,
    logger,
    sandboxContainerManager: { getStatus: effects },
    preserveWorkspace: effects,
  } as unknown as Parameters<typeof reconcileSandboxSessions>[0]);
  expect(effects).not.toHaveBeenCalled();
  expect(retainedTables()).toEqual(before);
});

it.each([
  'local',
  'sandbox',
] as const)('restart leaves archived resource claims untouched (%s)', async (target) => {
  seed('archived', 'running', target);
  // A historical archived task can still have execution evidence. Visibility is
  // not a terminal state; simulate that history only inside this fixture DB.
  db.prepare(
    'INSERT INTO pod_fleet_archives (pod_id,archived_at,actor_id,reason) VALUES (?,?,?,?)',
  ).run('archived', new Date().toISOString(), 'human', 'Preserve this unknown execution');
  const before = retainedTables();
  const cm = { getStatus: effects, stop: effects, start: effects, remove: effects };
  if (target === 'local')
    await reconcileLocalSessions({
      podRepo: repo,
      logger,
      containerManager: cm,
      enqueueSession: effects,
    } as unknown as Parameters<typeof reconcileLocalSessions>[0]);
  else
    await reconcileSandboxSessions({
      podRepo: repo,
      logger,
      sandboxContainerManager: cm,
      preserveWorkspace: effects,
      quiesceSandboxAgent: effects,
      suspendSandbox: effects,
      enqueueSession: effects,
    } as unknown as Parameters<typeof reconcileSandboxSessions>[0]);
  expect(effects).not.toHaveBeenCalled();
  expect(retainedTables()).toEqual(before);
});
