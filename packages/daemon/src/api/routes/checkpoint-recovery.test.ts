import { rm } from 'node:fs/promises';
import { AutopodError } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockedCheckpointOutcomeFixture,
  retainedCheckpointFixture,
} from '../../test-utils/retained-checkpoint-helpers.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { checkpointRecoveryRoutes } from './checkpoint-recovery.js';

describe('human-only retained checkpoint selection', () => {
  let f: Awaited<ReturnType<typeof retainedCheckpointFixture>>;
  let app: ReturnType<typeof Fastify>;
  const headers = { authorization: 'Bearer human-token' };
  const endpoint = () => `/pods/${f.podId}/checkpoint-recovery`;
  beforeEach(async () => {
    f = await retainedCheckpointFixture();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    checkpointRecoveryRoutes(app, {
      prepareRewriteRepair: f.recovery.prepareRewriteRepair,
      checkRewriteRepair: f.recovery.checkRewriteRepair,
      getApprovalSourceRewrite: f.manager.getApprovalSourceRewrite,
      recoverCheckpoint: f.recovery.submit,
      getCheckpointRecoveries: f.recovery.list,
      reconcileCheckpointOutcome: f.recovery.reconcileOutcome,
      continueRetained: f.recovery.continueRetained,
      checkRetainedCandidate: (...args: Parameters<typeof f.recovery.checkCandidate>) =>
        f.recovery.checkCandidate(...args),
      previewRetainedExecution: f.recovery.previewExecution,
    });
    await app.ready();
  });
  afterEach(async () => {
    await f.recovery.wait(f.input.id);
    await app.close();
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('strictly authenticates new continuation and candidate selection without accepting caller proof', async () => {
    const url = `/pods/${f.podId}/retained-continuation`;
    const input = { ...f.input, prepareOnly: true };
    for (const authorization of [undefined, 'Bearer pod-token']) {
      for (const path of [url, `${url}/${f.input.id}/check`]) {
        const result = await app.inject({
          method: 'POST',
          url: path,
          payload: input,
          headers: authorization ? { authorization } : {},
        });
        expect(result.statusCode).toBe(401);
      }
    }
    for (const extra of [
      { force: true },
      { actor: f.actor },
      { sourcePath: '/tmp/other' },
      { launchConfig: {} },
      { result: { overall: 'pass' } },
      { checkpointHead: 'main' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...input, ...extra } }))
          .statusCode,
      ).toBe(400);
    }
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    f.worktrees.selectRetainedContinuationSource = vi.fn(async () => ({
      head: f.prepared.head,
      tree: f.prepared.tree,
      baseCommitSha: '1'.repeat(40),
    }));
    const result = await app.inject({ method: 'POST', url, headers, payload: input });
    expect(result.statusCode, result.body).toBe(202);
    await f.recovery.wait(f.input.id);
    expect(f.pod().status).toBe('review_required');
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    const check = await app.inject({
      method: 'POST',
      url: `${url}/${f.input.id}/check`,
      headers,
      payload: {
        expectedGeneration: f.input.expectedGeneration,
        expectedResultHash: f.input.expectedResultHash,
        candidateHead: f.prepared.head,
        reason: 'Select prepared exact source for new checks and independent review',
      },
    });
    expect(check.statusCode, check.body).toBe(202);
    expect(check.json().operation.selected.head).toBe(f.prepared.head);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
  });
  it('transports paired late execution selection to the human controller and refuses incomplete or caller-authored evidence', async () => {
    const input = {
      expectedGeneration: f.input.expectedGeneration,
      expectedResultHash: f.input.expectedResultHash,
      candidateHead: f.prepared.head,
      reason: 'Select this exact candidate with a qualified execution preview',
    };
    const url = `/pods/${f.podId}/retained-continuation/${f.input.id}/check`;
    const controller = vi
      .spyOn(f.recovery, 'checkCandidate')
      .mockRejectedValue(
        new AutopodError('Transport probe; no source selection performed', 'TRANSPORT_PROBE', 409),
      );
    for (const extra of [
      { executionProfileId: 'qualified' },
      { expectedExecutionDigest: 'a'.repeat(64) },
      { executionProfileId: 'qualified', expectedExecutionDigest: 'invalid' },
      { execution: {} },
      { force: true },
      { actor: f.actor },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...input, ...extra } }))
          .statusCode,
      ).toBe(400);
    expect(controller).not.toHaveBeenCalled();
    const selected = {
      ...input,
      executionProfileId: 'qualified',
      expectedExecutionDigest: 'a'.repeat(64),
    };
    expect((await app.inject({ method: 'POST', url, headers, payload: selected })).statusCode).toBe(
      409,
    );
    expect(controller).toHaveBeenCalledWith(f.podId, f.input.id, selected, {
      type: 'human',
      userId: expect.any(String),
    });
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });
  it('requires a separate human budgeted transport and rejects ignored or caller-authored budget proof', async () => {
    const plain = `/pods/${f.podId}/retained-continuation/${f.input.id}/check`;
    const url = `${plain}-budgeted`;
    const input = {
      expectedGeneration: f.input.expectedGeneration,
      expectedResultHash: f.input.expectedResultHash,
      candidateHead: f.prepared.head,
      reason: 'Select exact source for one fresh independent validation',
    };
    const budget = {
      seconds: 1800,
      reason: 'Measured full suite needs a finite larger outer timeout',
    };
    const controller = vi
      .spyOn(f.recovery, 'checkCandidate')
      .mockRejectedValue(new AutopodError('Probe only', 'PROBE', 409));
    for (const authorization of [undefined, 'Bearer pod-token'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { ...input, testBudget: budget },
            headers: authorization ? { authorization } : {},
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: plain,
          headers,
          payload: { ...input, testBudget: budget },
        })
      ).statusCode,
    ).toBe(400);
    for (const extra of [
      {},
      { testBudget: { ...budget, seconds: 3601 } },
      { testBudget: { ...budget, seconds: 1.5 } },
      { testBudget: { ...budget, reason: 'short' } },
      { testBudget: { ...budget, frozenTimeoutSeconds: 900 } },
      { testBudget: budget, force: true },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...input, ...extra } }))
          .statusCode,
      ).toBe(400);
    expect(controller).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...input, testBudget: budget },
        })
      ).statusCode,
    ).toBe(409);
    expect(controller).toHaveBeenCalledWith(
      f.podId,
      f.input.id,
      { ...input, testBudget: budget },
      { type: 'human', userId: expect.any(String) },
    );
  });

  it('inspects without any provider observation, credential rotation or queue dispatch', async () => {
    const result = await app.inject({ url: endpoint(), headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toEqual({ operations: [] });
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });
  it('requires authentication and refuses caller proof, force, source substitution and actor fields', async () => {
    expect(
      (await app.inject({ method: 'POST', url: endpoint(), payload: f.input })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: endpoint(),
          headers: { authorization: 'Bearer pod-token' },
          payload: f.input,
        })
      ).statusCode,
    ).toBe(401);
    for (const extra of [
      { force: true },
      { actor: f.actor },
      { exitCode: 0 },
      { sourcePath: '/tmp/other' },
      { expectedGeneration: 0 },
      { checkpointHead: 'main' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: endpoint(),
        headers,
        payload: { ...f.input, ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });
  it('strictly authenticates outcome reconciliation and preserves failed checks on replay', async () => {
    const input = await blockedCheckpointOutcomeFixture(f);
    const url = `${endpoint()}/${f.input.id}/reconcile`;
    for (const authorization of [undefined, 'Bearer pod-token']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: authorization ? { authorization } : {},
        payload: input,
      });
      expect(response.statusCode).toBe(401);
    }
    for (const extra of [
      { force: true },
      { exitCode: 0 },
      { actor: f.actor },
      { sourcePath: '/tmp/other' },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...input, ...extra } }))
          .statusCode,
      ).toBe(400);
    const count = vi.mocked(f.ctx.validationEngine.validate).mock.calls.length;
    const response = await app.inject({ method: 'POST', url, headers, payload: input });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().operation).toMatchObject({
      checked: { result: { overall: 'fail' } },
      reconciled: { actor: { type: 'human' } },
    });
    expect((await app.inject({ method: 'POST', url, headers, payload: input })).json()).toEqual(
      response.json(),
    );
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(count);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('review_required');
  });
  it('returns a durable 202 selection before preparation completes and replays without another operation', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<typeof f.prepared>((resolve) => {
      finish = () => resolve(f.prepared);
    });
    vi.mocked(f.deps.prepare!).mockReturnValue(pending);
    const response = await app.inject({
      method: 'POST',
      url: endpoint(),
      headers,
      payload: f.input,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().operation).toMatchObject({
      id: f.input.id,
      actor: { type: 'human' },
      activated: null,
    });
    const replay = await app.inject({ method: 'POST', url: endpoint(), headers, payload: f.input });
    expect(replay.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    await f.recovery.wait(f.input.id);
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: endpoint(), headers })).json().operations[0]).toMatchObject({
      activated: { generation: 2 },
      checked: null,
    });
  });
});
