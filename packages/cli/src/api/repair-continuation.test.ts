import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  canonicalConfiguration,
  repairContinuationInspectionV1Schema,
  repairContinuationOperationV1Schema,
  repairContinuationPreviewV1Schema,
  repairContinuationRequestV1Schema,
} from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  repairInspection,
  repairOperation,
  repairPreview,
  repairRequest,
} from '../test-utils/repair-continuation.js';
import { AutopodClient } from './client.js';

const fetch = vi.fn();
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetch(...args) }));
const token = vi.fn(async () => 'synthetic');
const client = new AutopodClient({ baseUrl: 'https://fixture.invalid', getToken: token });
function reply(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}
beforeEach(() => {
  fetch.mockReset();
  token.mockClear();
});
describe('repair continuation versioned transport', () => {
  it('consumes captured real backend qualified/failed/final projections with distinct operation/custody IDs', async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../desktop/Tests/Fixtures/repair-continuation-backend.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    fetch.mockResolvedValueOnce(reply(fixture.inspection));
    expect(
      (await client.inspectRepairContinuation(fixture.inspection.podId)).sourceHead,
    ).toBeNull();
    for (const key of [
      'qualified',
      'failed',
      'validated',
      'restartedSealed',
      'restartedValidated',
      'restartedFailedChecks',
      'restartedUnsettled',
    ]) {
      const wire = fixture[key];
      fetch.mockResolvedValueOnce(reply(wire));
      const result = await client.observeRepairContinuation(wire.podId, wire.request.id);
      expect(result).toEqual(wire);
      expect(result.operationId).not.toBe(result.request.id);
      expect(result.qualification?.binding.operationId).toBe(result.operationId);
      expect(result.qualification?.binding.custodyId).toBe(result.operationId);
      if (result.codingFinalSource)
        expect(result.codingFinalSource.operationId).toBe(result.operationId);
    }
    for (const key of [
      'restartedSealedInspection',
      'restartedValidatedInspection',
      'restartedFailedChecksInspection',
      'restartedUnsettledInspection',
    ]) {
      const wire = fixture[key];
      fetch.mockResolvedValueOnce(reply(wire));
      expect(await client.inspectRepairContinuation(wire.podId)).toEqual(wire);
    }
    expect(fetch.mock.calls).toHaveLength(12);
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it.each([
    'operation',
    'custody',
    'final',
    'missing-public-id',
    'binding-digest',
    'resource',
    'repository',
    'base',
    'unknown-field',
  ])('refuses %s identity drift instead of dropping proof correlation', async (field) => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../desktop/Tests/Fixtures/repair-continuation-backend.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const wire = structuredClone(fixture.validated);
    if (field === 'operation') wire.qualification.binding.operationId = wire.request.id;
    if (field === 'custody') wire.qualification.binding.custodyId = wire.request.id;
    if (field === 'final') wire.codingFinalSource.operationId = wire.request.id;
    if (field === 'missing-public-id') delete wire.operationId;
    if (field === 'binding-digest') wire.qualification.bindingDigest = '0'.repeat(64);
    if (field === 'resource') wire.qualification.binding.resourceKey += '-other';
    if (field === 'repository') wire.codingFinalSource.source.repository += '/other';
    if (field === 'base') wire.codingFinalSource.source.baseCommitSha = '0'.repeat(40);
    if (field === 'unknown-field') wire.qualification.binding.extra = 'must not be dropped';
    if (['operation', 'custody', 'unknown-field'].includes(field))
      wire.qualification.bindingDigest = createHash('sha256')
        .update(canonicalConfiguration(wire.qualification.binding))
        .digest('hex');
    fetch.mockResolvedValueOnce(reply(wire));
    await expect(client.observeRepairContinuation(wire.podId, wire.request.id)).rejects.toThrow(
      'uncorrelated',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('matches the backend canonical digest vectors including resource floats and nested arrays', () => {
    const vectors: { wire: string; digest: string }[] = JSON.parse(
      readFileSync(
        new URL(
          '../../../desktop/Tests/Fixtures/configuration-digest-vectors.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    for (const vector of vectors)
      expect(
        createHash('sha256')
          .update(canonicalConfiguration(JSON.parse(vector.wire)))
          .digest('hex'),
      ).toBe(vector.digest);
  });
  it('keeps native fixtures compatible with the pinned shared schemas including sealed source', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../desktop/Tests/Fixtures/repair-continuation-v1.json', import.meta.url),
        'utf8',
      ),
    );
    repairContinuationRequestV1Schema.parse(fixture.request);
    repairContinuationInspectionV1Schema.parse(fixture.inspection);
    repairContinuationPreviewV1Schema.parse(fixture.preview);
    repairContinuationOperationV1Schema.parse(fixture.operation);
    repairContinuationOperationV1Schema.parse(fixture.validatedOperation);
  });
  it('inspects, previews and observes with GET only; conditional eligibility is not qualification', async () => {
    fetch
      .mockResolvedValueOnce(reply(repairInspection))
      .mockResolvedValueOnce(reply(repairPreview))
      .mockResolvedValueOnce(reply(repairOperation));
    expect(await client.inspectRepairContinuation('pod')).toEqual(repairInspection);
    const preview = await client.previewRepairContinuation('pod', {
      sourceHead: repairRequest.sourceHead,
      executionProfileId: repairRequest.executionProfileId,
    });
    expect(preview.conditionalAttemptEligible).toBe(true);
    expect(preview.actualQualification).toBe('not_run');
    const observed = await client.observeRepairContinuation('pod', repairRequest.id);
    expect(observed.qualification).toBeNull();
    expect(observed.codingAdmission).toBe('not_admitted');
    expect(fetch.mock.calls.map(([, request]) => request.method)).toEqual(['GET', 'GET', 'GET']);
    expect(fetch.mock.calls[1]?.[0]).toContain('/repair-continuation-v1/preview?sourceHead=');
    expect(fetch.mock.calls[2]?.[0]).toBe(
      'https://fixture.invalid/pods/pod/repair-continuation-v1/requests/stable-request',
    );
  });
  it('authorizes exactly the pinned body, accepts claimed not qualified, and keeps same body/key on 401', async () => {
    fetch
      .mockResolvedValueOnce(reply({ error: 'expired' }, 401))
      .mockResolvedValueOnce(reply(repairOperation, 202));
    const result = await client.authorizeRepairContinuation('pod', repairRequest);
    expect(result.state).toBe('claimed');
    expect(result.qualification).toBeNull();
    expect(result.codingAdmission).toBe('not_admitted');
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [path, init] of fetch.mock.calls) {
      expect(path).toBe('https://fixture.invalid/pods/pod/repair-continuation-v1');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual(repairRequest);
    }
    expect(fetch.mock.calls[0]?.[1].body).toBe(fetch.mock.calls[1]?.[1].body);
  });
  it.each([
    401, 404, 409, 501,
  ])('refuses HTTP %s with no older-mutation fallback', async (status) => {
    fetch.mockResolvedValue(
      reply({ error: 'unsupported or same-key conflict', code: 'CONFLICT' }, status),
    );
    await expect(client.authorizeRepairContinuation('pod', repairRequest)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    expect(fetch.mock.calls.every(([path]) => path.endsWith('/repair-continuation-v1'))).toBe(true);
  });
  it('does not retry a lost response', async () => {
    fetch.mockRejectedValue(new Error('response lost'));
    await expect(client.authorizeRepairContinuation('pod', repairRequest)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    {},
    { ...repairOperation, version: 99 },
    { ...repairOperation, podId: 'other' },
    {
      ...repairOperation,
      request: { ...repairRequest, reason: 'Different saved authorization reason' },
    },
    { ...repairOperation, originalGeneration: 3 },
    { ...repairOperation, codingAdmission: 'consumed' },
    { ...repairOperation, state: 'validated', checks: 'passed' },
    { ...repairOperation, publicationAuthorized: true },
  ])('rejects malformed or uncorrelated 202 without claiming success', async (body) => {
    fetch.mockResolvedValue(reply(body, 202));
    await expect(client.authorizeRepairContinuation('pod', repairRequest)).rejects.toThrow(
      'Uncorrelated'.toLowerCase(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects stale/uncorrelated preview and observe identities', async () => {
    fetch
      .mockResolvedValueOnce(
        reply({
          ...repairPreview,
          selection: { ...repairPreview.selection, sourceHead: '1'.repeat(40) },
        }),
      )
      .mockResolvedValueOnce(
        reply({ ...repairOperation, request: { ...repairRequest, id: 'other' } }),
      );
    await expect(
      client.previewRepairContinuation('pod', {
        sourceHead: repairRequest.sourceHead,
        executionProfileId: repairRequest.executionProfileId,
      }),
    ).rejects.toThrow();
    await expect(client.observeRepairContinuation('pod', repairRequest.id)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('validates strict authorization before auth/network, refusing caller proof/grants', async () => {
    await expect(
      client.authorizeRepairContinuation('pod', {
        ...repairRequest,
        proof: true,
      } as typeof repairRequest),
    ).rejects.toThrow();
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
