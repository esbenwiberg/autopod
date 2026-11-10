import type {
  RecoveryForkInspection,
  RecoveryForkOperation,
  RecoveryForkPreview,
} from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryForkRejectedBeforeClaim } from '../../pods/recovery-fork-rejection.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { recoveryForkRoutes } from './recovery-fork.js';

const input = {
  version: 1 as const,
  expectedGeneration: 1,
  sourceHead: 'a'.repeat(40),
  executionProfileId: '@original',
  instructions: 'Continue the task after inspecting the preserved work.',
  files: [],
  acknowledgePartialSource: true as const,
};
const request = { ...input, id: 'human-request', expectedBinding: 'b'.repeat(64) };
const context = {
  summary: 'Visible task',
  failure: 'Visible failure',
  messages: [],
  truncated: false,
  omissions: ['Bounded context'],
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  const inspection: RecoveryForkInspection = {
    version: 1,
    podId: 'pod',
    generation: 1,
    available: true,
    blockers: [],
    source: null,
    context,
    budget: null,
    profiles: [],
    operation: null,
    lineage: null,
  };
  const preview: RecoveryForkPreview = {
    version: 1,
    podId: 'pod',
    generation: 1,
    available: true,
    blockers: [],
    expectedBinding: request.expectedBinding,
    source: null,
    context,
    budget: null,
    execution: null,
    input,
  };
  const operation: RecoveryForkOperation = {
    version: 1,
    id: request.id,
    parentPodId: 'pod',
    generation: 1,
    actorId: 'operator-oid',
    request,
    state: 'queued',
    childPodId: 'real-admitted-child',
    childStatus: 'queued',
    sourceHead: input.sourceHead,
    copiedFiles: [],
    context,
    error: null,
    createdAt: '2026-11-10',
  };
  const manager = {
    inspectRecoveryFork: vi.fn(async () => inspection),
    previewRecoveryFork: vi.fn(async () => preview),
    createRecoveryFork: vi.fn(async () => operation),
    getRecoveryFork: vi.fn(() => operation),
  };
  recoveryForkRoutes(app, manager);
  await app.ready();
  return { app, manager, inspection, preview, operation };
}
const headers = { authorization: 'Bearer human-token' };
const base = '/pods/pod/recovery-fork';
describe('recovery-fork human API', () => {
  it.each([
    ['GET', base],
    ['POST', `${base}/preview`],
    ['POST', base],
    ['GET', `${base}/human-request`],
  ] as const)('%s %s rejects anonymous and pod tokens with no-store', async (method, url) => {
    const f = await fixture();
    for (const token of [undefined, 'pod-token']) {
      const result = await f.app.inject({
        method,
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(method === 'POST' ? { payload: request } : {}),
      });
      expect(result.statusCode).toBe(401);
      expect(result.headers['cache-control']).toBe('no-store');
    }
    for (const method of Object.values(f.manager)) expect(method).not.toHaveBeenCalled();
  });
  it('keeps reads/preview separate and returns exact actor-bound operation observations', async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'GET', url: base, headers })).json()).toEqual(
      f.inspection,
    );
    expect(
      (
        await f.app.inject({ method: 'POST', url: `${base}/preview`, headers, payload: input })
      ).json(),
    ).toEqual(f.preview);
    expect(f.manager.createRecoveryFork).not.toHaveBeenCalled();
    const accepted = await f.app.inject({ method: 'POST', url: base, headers, payload: request });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual(f.operation);
    expect(f.manager.createRecoveryFork).toHaveBeenCalledExactlyOnceWith('pod', request, {
      type: 'human',
      userId: 'operator-oid',
    });
    const get = await f.app.inject({ method: 'GET', url: `${base}/${request.id}`, headers });
    expect(get.json()).toEqual(f.operation);
    expect(get.headers['cache-control']).toBe('no-store');
    f.operation.state = 'unknown';
    expect(
      (await f.app.inject({ method: 'POST', url: base, headers, payload: request })).statusCode,
    ).toBe(200);
  });
  it.each([
    { ...request, actorId: 'attacker' },
    { ...request, authority: 'merge' },
    { ...request, acknowledgePartialSource: false },
    { ...request, files: [{ path: 'notes', version: 'bad' }] },
    {
      ...request,
      files: [
        { path: 'notes', version: 'c'.repeat(64) },
        { path: 'notes', version: 'c'.repeat(64) },
      ],
    },
  ])('rejects strict invalid mutation %j before manager entry', async (payload) => {
    const f = await fixture();
    const result = await f.app.inject({ method: 'POST', url: base, headers, payload });
    expect(result.statusCode).toBe(400);
    expect(f.manager.createRecoveryFork).not.toHaveBeenCalled();
  });
});

describe('explicit pre-claim rejection proof route', () => {
  it('serializes only exact coordinator proof with no-store', async () => {
    const f = await fixture();
    f.manager.createRecoveryFork.mockRejectedValue(
      new RecoveryForkRejectedBeforeClaim('pod', request, 'RECOVERY_FORK_SELECTION_STALE'),
    );
    const result = await f.app.inject({ method: 'POST', url: base, headers, payload: request });
    expect(result.statusCode).toBe(409);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toEqual({
      code: 'RECOVERY_FORK_REJECTED_BEFORE_CLAIM',
      parentPodId: 'pod',
      requestId: request.id,
      expectedBinding: request.expectedBinding,
      noOperationCreated: true,
      error: expect.any(String),
      reasonCode: 'RECOVERY_FORK_SELECTION_STALE',
    });
  });
  it.each([
    '404',
    'unknown',
    'generic',
    'parent',
    'request',
    'binding',
  ] as const)('never infers rejection proof for %s errors', async (kind) => {
    const f = await fixture();
    const error =
      kind === '404'
        ? new AutopodError('Missing', 'NOT_FOUND', 404)
        : kind === 'unknown'
          ? new Error('uncertain outcome')
          : kind === 'generic'
            ? new AutopodError('Rejected', 'RECOVERY_FORK_BLOCKED', 409)
            : new RecoveryForkRejectedBeforeClaim(
                kind === 'parent' ? 'other' : 'pod',
                {
                  ...request,
                  id: kind === 'request' ? 'other' : request.id,
                  expectedBinding: kind === 'binding' ? 'f'.repeat(64) : request.expectedBinding,
                },
                'RECOVERY_FORK_SELECTION_STALE',
              );
    f.manager.createRecoveryFork.mockRejectedValue(error);
    const result = await f.app.inject({ method: 'POST', url: base, headers, payload: request });
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
    expect(result.json()).not.toHaveProperty('noOperationCreated');
    expect(result.json()).not.toHaveProperty('parentPodId');
    expect(result.headers['cache-control']).toBe('no-store');
  });
});
