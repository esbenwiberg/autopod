import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validationResultHash } from '../../pods/validation-execution-ledger.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { validationRecoveryFixture } from '../../test-utils/validation-recovery-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { podRoutes } from './pods.js';

const identity = {
  source: 'a'.repeat(64),
  contract: 'b'.repeat(64),
  commands: 'c'.repeat(64),
  environment: null,
  implementation: null,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = validationRecoveryFixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'validation-custody-'));
  await writeFile(path.join(dir, 'partial.txt'), 'original failed assertion');
  f.podRepo.update(f.podId, { containerId: null });
  f.podRepo.update(f.podId, {
    executionTarget: 'sandbox',
    containerId: '11111111-1111-4111-8111-111111111111',
    worktreePath: dir,
    lastValidationResult: null,
  });
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  podRoutes(app, f.manager);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    f.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ledger = f.podRepo.validationExecutions;
  const retries = f.podRepo.taskRetries;
  if (!ledger || !retries) throw new Error('Missing ledgers');
  const dispatch = (kind: 'published' | 'outcome' | 'missing') => {
    const admission = retries.admit(
      f.podId,
      f.podRepo.getOrThrow(f.podId).lifecycleGeneration,
      identity,
      'd'.repeat(64),
      [],
    );
    retries.start(admission.id);
    const id = ledger.dispatch(f.podRepo.getOrThrow(f.podId), admission.id, 1, 'test-scope');
    if (!id) throw new Error('Missing dispatch');
    const result = {
      ...f.result,
      executionDispatchId: id,
      infrastructureFailure: {
        phase: 'test' as const,
        code: 'EXEC_EXIT_UNVERIFIED',
        message: 'Unknown execution',
        retryable: false,
      },
    };
    if (kind !== 'missing') ledger.recordOutcome(result, id);
    if (kind === 'published') {
      ledger.recordResult(result, id);
      f.podRepo.update(f.podId, { lastValidationResult: result });
    }
    retries.finish(admission.id, 'nonretryable', 1);
    return { id, result };
  };
  vi.mocked(f.containerManager.kill).mockImplementation(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return {
    ...f,
    app,
    dir,
    dispatch,
    post: (route: string) =>
      app.inject({
        method: 'POST',
        url: `/pods/${f.podId}/${route}`,
        headers: { authorization: 'Bearer human-token' },
        payload: { reason: 'Preserve original evidence' },
      }),
  };
}
describe('public controls retain validation custody', () => {
  it.each(['published', 'outcome', 'missing'] as const)(
    'preview refuses %s before any provider call and retains physical reports',
    async (kind) => {
      const f = await fixture();
      f.dispatch(kind);
      vi.mocked(f.containerManager.getStatus).mockResolvedValue('stopped');
      vi.mocked(f.containerManager.start).mockImplementation(async () => {
        await writeFile(path.join(f.dir, 'partial.txt'), 'changed by preview resume');
        throw new Error('Unsafe preview reached resource');
      });
      const response = await f.post('preview');
      expect(response.statusCode).toBe(409);
      expect(f.containerManager.getStatus).not.toHaveBeenCalled();
      expect(f.containerManager.start).not.toHaveBeenCalled();
      expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
      expect(await readFile(path.join(f.dir, 'partial.txt'), 'utf8')).toBe(
        'original failed assertion',
      );
    },
  );

  it('serves authenticated exact unpublished output without releasing task custody', async () => {
    const f = await fixture();
    const { id, result } = f.dispatch('outcome');
    const hash = validationResultHash(result);
    const inspection = await f.app.inject({
      url: `/pods/${f.podId}/validation-execution-recovery`,
      headers: { authorization: 'Bearer human-token' },
    });
    expect(inspection.json()).toMatchObject({
      required: true,
      dispatchId: id,
      resultHash: hash,
      code: 'VALIDATION_RESULT_PUBLICATION_UNVERIFIED',
    });
    const endpoint = `/pods/${f.podId}/validation-execution-evidence/${id}?resultHash=${hash}`;
    expect((await f.app.inject({ url: endpoint })).statusCode).toBe(401);
    const headers = { authorization: 'Bearer human-token' };
    const read = await f.app.inject({ url: endpoint, headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      evidenceKind: 'outcome',
      dispatchId: id,
      resultHash: hash,
      result,
    });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(
      (await f.app.inject({ url: endpoint.replace(hash, 'a'.repeat(64)), headers })).statusCode,
    ).toBe(404);
    const other = f.manager.createSession(
      { profileName: 'test-profile', task: 'Other evidence owner' },
      'operator',
    );
    expect(
      (await f.app.inject({ url: endpoint.replace(f.podId, other.id), headers })).statusCode,
    ).toBe(404);
    expect(f.podRepo.getOrThrow(f.podId).lastValidationResult).toBeNull();
    expect(() => f.podRepo.validationExecutions?.assertTaskSettled(f.podId)).toThrow();
    expect(
      f.db.prepare('SELECT * FROM validation_dispatch_results WHERE dispatch_id=?').all(id),
    ).toEqual([]);
  });
  it('refuses a late dispatch after recovery status inspection before waking the sandbox', async () => {
    const f = await fixture();
    f.podRepo.update(f.podId, { worktreeCompromised: true });
    vi.mocked(f.containerManager.getStatus).mockImplementationOnce(async () => {
      f.dispatch('missing');
      return 'stopped';
    });
    const response = await f.post('recover-worktree');
    expect(response.statusCode).toBe(409);
    expect(f.containerManager.start).not.toHaveBeenCalled();
    expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
    expect(f.podRepo.getOrThrow(f.podId).worktreeCompromised).toBe(true);
    expect(await readFile(path.join(f.dir, 'partial.txt'), 'utf8')).toBe(
      'original failed assertion',
    );
  });

  it.each(['published', 'outcome', 'missing'] as const)(
    'force-complete refuses %s execution before destructive cleanup',
    async (kind) => {
      const f = await fixture();
      f.dispatch(kind);
      const before = f.podRepo.getOrThrow(f.podId);
      const response = await f.post('force-complete');
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('VALIDATION_EXECUTION_UNVERIFIED');
      expect(f.containerManager.kill).not.toHaveBeenCalled();
      expect(f.podRepo.getOrThrow(f.podId)).toEqual(before);
      expect(await readFile(path.join(f.dir, 'partial.txt'), 'utf8')).toBe(
        'original failed assertion',
      );
    },
  );
  it('rechecks a dispatch created during awaited cleanup before deleting the resource', async () => {
    const f = await fixture();
    f.deps.beforeContainerCleanup = async () => {
      f.dispatch('missing');
    };
    const response = await f.post('force-complete');
    expect(response.statusCode).toBe(409);
    expect(f.containerManager.kill).not.toHaveBeenCalled();
    expect(f.podRepo.getOrThrow(f.podId).status).toBe('failed');
    expect(await readFile(path.join(f.dir, 'partial.txt'), 'utf8')).toBe(
      'original failed assertion',
    );
  });
  it.each(['recover-worktree', 'update-from-base'])(
    '%s refuses before wake,checkpoint or rebase',
    async (route) => {
      const f = await fixture();
      f.dispatch('missing');
      if (route === 'recover-worktree') f.podRepo.update(f.podId, { worktreeCompromised: true });
      const response = await f.post(route);
      expect(response.statusCode).toBe(409);
      expect(f.containerManager.start).not.toHaveBeenCalled();
      expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
      expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
      expect(await readFile(path.join(f.dir, 'partial.txt'), 'utf8')).toBe(
        'original failed assertion',
      );
    },
  );
});
