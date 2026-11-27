import { AutopodError } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  AzureSandboxApiClient,
  type WebSocketLike,
} from '../containers/azure-sandbox-api-client.js';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createLocalValidationEngine } from '../validation/local-validation-engine.js';
import { createPodRepository } from './pod-repository.js';
import { requiresValidationSettlement } from './validation-recovery-policy.js';

type Failure =
  | 'empty-upload-403'
  | 'upload-403'
  | 'chmod'
  | 'auth'
  | 'socket'
  | 'before-start'
  | 'after-start'
  | 'send';

function transport(failure: Failure) {
  const requests: Array<{ url: string; method: string }> = [];
  const frames: string[] = [];
  let staged = false;
  const client = new AzureSandboxApiClient(
    {
      subscriptionId: 'sub',
      resourceGroup: 'group',
      location: 'swedencentral',
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      credential: {
        async getToken() {
          if (failure === 'auth' && staged) throw new Error('fixture authentication failed');
          return { token: 'fixture' };
        },
      },
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? 'GET' });
        if (url.includes('/files') && init?.method === 'PUT') {
          if (failure === 'empty-upload-403') return new Response('', { status: 403 });
          if (failure === 'upload-403')
            return Response.json({ message: 'upload rejected' }, { status: 403 });
          return new Response(null, { status: 204 });
        }
        const command = String(init?.body);
        if (command.includes('chmod')) {
          staged = true;
          if (failure === 'chmod') throw new TypeError('fixture chmod response lost');
        }
        return Response.json({ stdout: '', stderr: '', exitCode: 0 });
      },
      webSocket: () => {
        if (failure === 'socket') throw new Error('fixture socket construction failed');
        const socket: WebSocketLike = {
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send(frame) {
            frames.push(frame);
            if (failure === 'send') throw new Error('fixture send response lost');
          },
          close() {
            socket.onclose?.({ code: 1006 });
          },
        };
        queueMicrotask(() => {
          if (failure !== 'before-start') socket.onopen?.({});
          socket.onclose?.({ code: 1006 });
        });
        return socket;
      },
    },
    logger,
  );
  return { client, requests, frames };
}

describe('validation pre-dispatch evidence through adapter, manager, engine and ledger', () => {
  it('cancels during wrapper staging without a late target start or fabricated exit', async () => {
    const t = transport('after-start');
    let release = () => {};
    const staging = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(t.client, 'writeFile').mockImplementation(async () => {
      await staging;
    });
    const handle = await new SandboxContainerManager(t.client, logger).execStreaming('sandbox', [
      'target',
    ]);
    const killed = handle.kill();
    void killed.catch(() => {});
    release();
    await expect(handle.exitCode).rejects.toMatchObject({
      code: 'EXEC_NOT_DISPATCHED',
      nonDispatch: { boundary: 'wrapper-staging' },
    });
    await expect(killed).rejects.toMatchObject({ code: 'EXEC_NOT_DISPATCHED' });
    expect(t.frames).toEqual([]);
    expect(t.requests).toEqual([]);
  });

  it.each<Failure>([
    'empty-upload-403',
    'upload-403',
    'chmod',
    'auth',
    'socket',
    'before-start',
    'after-start',
    'send',
  ])('records truthful durable custody for %s', async (failure) => {
    const db = createTestDb();
    try {
      insertTestProfile(db);
      const repo = createPodRepository(db);
      repo.insert({
        id: 'worker',
        profileName: 'test-profile',
        task: 'Validate candidate',
        model: 'model',
        runtime: 'codex',
        branch: 'feature',
        userId: 'operator',
        status: 'validating',
        executionTarget: 'sandbox',
        maxValidationAttempts: 3,
        skipValidation: false,
        outputMode: 'pr',
      });
      repo.update('worker', {
        containerId: '11111111-1111-4111-8111-111111111111',
        worktreePath: '/retained/source',
      });
      const pod = repo.getOrThrow('worker');
      const retries = repo.taskRetries;
      const ledger = repo.validationExecutions;
      if (!retries || !ledger || !pod.containerId) throw new Error('Missing execution fixture');
      const admission = retries.admit(
        pod.id,
        pod.lifecycleGeneration,
        {
          source: 'a'.repeat(64),
          contract: 'b'.repeat(64),
          commands: 'c'.repeat(64),
          environment: null,
          implementation: null,
        },
        'd'.repeat(64),
        [],
      );
      retries.start(admission.id);
      const t = transport(failure);
      const manager = new SandboxContainerManager(t.client, logger);
      const dispatch = ledger.dispatch(pod, admission.id, 1, manager.executionResourceScope);
      if (!dispatch) throw new Error('Missing durable dispatch');
      const binding = db.prepare('SELECT * FROM validation_dispatches').all();
      const engine = createLocalValidationEngine(manager, logger);
      const result = await engine.validate({
        podId: pod.id,
        containerId: pod.containerId,
        executionTarget: 'sandbox',
        previewUrl: '',
        buildCommand: '',
        validationSetupCommand: 'target-validation-command',
        startCommand: '',
        healthPath: '',
        healthTimeout: 1,
        smokePages: [],
        attempt: 1,
        task: 'Validate candidate',
        diff: '',
        hasWebUi: false,
        skipPhases: ['review'],
      });
      result.executionDispatchId = dispatch;
      ledger.recordOutcome(result, dispatch);
      ledger.recordResult(result, dispatch);
      repo.update(pod.id, { lastValidationResult: result });
      retries.finish(
        admission.id,
        result.infrastructureFailure?.retryable ? 'transient' : 'nonretryable',
        1,
      );
      expect(retries.state(pod.id).latest?.outcome).toBe(
        failure === 'empty-upload-403' ? 'transient' : 'nonretryable',
      );
      expect(result.overall).toBe('fail');
      expect(db.prepare('SELECT * FROM validation_dispatches').all()).toEqual(binding);
      const outcome = db
        .prepare('SELECT result FROM validation_dispatch_outcomes WHERE dispatch_id=?')
        .get(dispatch) as { result: string };
      expect(JSON.parse(outcome.result)).toEqual(result);
      expect(() =>
        ledger.recordOutcome({ ...result, duration: result.duration + 1 }, dispatch),
      ).toThrow();
      const unknown = failure === 'after-start' || failure === 'send';
      expect(requiresValidationSettlement({ lastValidationResult: result })).toBe(unknown);
      expect(ledger.unsettled(pod.id) !== null).toBe(unknown);
      if (unknown) {
        expect(result.infrastructureFailure?.code).toBe('EXEC_EXIT_UNVERIFIED');
        expect(() => ledger.assertTaskSettled(pod.id)).toThrow();
        expect(t.frames).toHaveLength(1);
      } else {
        expect(result.infrastructureFailure).toMatchObject({
          code: 'EXEC_NOT_DISPATCHED',
          retryable: failure === 'empty-upload-403',
          nonDispatch: { provider: 'azure-sandbox' },
        });
        expect(result.infrastructureFailure?.execution).toBeUndefined();
        expect(() => ledger.assertTaskSettled(pod.id)).not.toThrow();
        expect(t.frames).toEqual([]);
        if (failure.includes('403')) expect(result.infrastructureFailure?.statusCode).toBe(403);
        if (failure === 'empty-upload-403')
          expect(t.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
      }
      expect(t.requests.filter((r) => r.method === 'PUT').length).toBeLessThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it.each([
    new Error('legacy unknown'),
    new AutopodError('arbitrary forbidden', 'AZURE_SANDBOX_API', 403),
  ])('keeps untyped or legacy no-exit errors unknown', async (error) => {
    const t = transport('after-start');
    vi.spyOn(t.client, 'execStream').mockImplementation(async function* () {
      yield { stdout: 'partial legacy output' };
      throw error;
    });
    const handle = await new SandboxContainerManager(t.client, logger).execStreaming('sandbox', [
      'target',
    ]);
    await expect(handle.exitCode).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
  });
});
