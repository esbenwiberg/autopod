import { describe, expect, it } from 'vitest';
import { createCliFixture } from '../test-utils/cli-executable.js';
import {
  repairInspection,
  repairOperation,
  repairPreview,
  repairRequest,
} from '../test-utils/repair-continuation.js';

const podId = 'retained-pod';
const apply = [
  'repair-continuation',
  podId,
  '--apply',
  '--request-id',
  repairRequest.id,
  '--generation',
  '2',
  '--result-hash',
  repairRequest.expectedResultHash,
  '--report-set-hash',
  repairRequest.expectedReportSetHash,
  '--head',
  repairRequest.sourceHead,
  '--execution-profile',
  repairRequest.executionProfileId,
  '--execution-digest',
  repairRequest.expectedExecutionDigest,
  '--binding-digest',
  repairRequest.expectedBindingDigest,
  '--reason',
  repairRequest.reason,
  '--json',
];

describe('built repair continuation executable against an isolated HTTP fixture', () => {
  it.each([
    'inspect',
    'preview',
    'observe',
  ])('%s is GET only and never starts work', async (mode) => {
    const body = {
      ...(mode === 'inspect'
        ? repairInspection
        : mode === 'preview'
          ? repairPreview
          : repairOperation),
      podId,
    };
    const fixture = await createCliFixture({
      respond: (response, number) => {
        response.statusCode = number === 1 ? 200 : 404;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(number === 1 ? body : { error: 'Context unavailable' }));
      },
    });
    try {
      const args = [
        'repair-continuation',
        podId,
        '--json',
        ...(mode === 'preview'
          ? [
              '--preview-execution',
              repairRequest.executionProfileId,
              '--head',
              repairRequest.sourceHead,
            ]
          : mode === 'observe'
            ? ['--observe', repairRequest.id]
            : []),
      ];
      const result = await fixture.start(args).result;
      expect(result.failure).toBeNull();
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      if (mode === 'preview') {
        expect(output.actualQualification).toBe('not_run');
        expect(output.conditionalAttemptEligible).toBe(true);
      }
      if (mode === 'observe') {
        expect(output.codingAdmission).toBe('not_admitted');
        expect(output.qualification).toBeNull();
      }
      expect(fixture.requests.length).toBe(mode === 'observe' ? 1 : 6);
      expect(fixture.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
  it('accepts a durable claimed 202, not a passing or qualified receipt', async () => {
    const fixture = await createCliFixture({ status: 202, body: { ...repairOperation, podId } });
    try {
      const result = await fixture.start(apply).result;
      expect(result.failure).toBeNull();
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.request).toEqual(repairRequest);
      expect(output.state).toBe('claimed');
      expect(output.qualification).toBeNull();
      expect(output.codingAdmission).toBe('not_admitted');
      expect(output.publicationAuthorized).toBe(false);
      expect(fixture.requests.map((request) => request.method)).toEqual(['POST']);
    } finally {
      await fixture.dispose();
    }
  });
  it.each([
    202, 404,
  ])('malformed/unsupported HTTP %s retains exact request identity, never falls back', async (status) => {
    const fixture = await createCliFixture({ status, body: {} });
    try {
      const result = await fixture.start(apply).result;
      expect(result.failure).toBeNull();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Authorization NOT confirmed');
      expect(result.stderr).toContain(`--observe "${repairRequest.id}"`);
      expect(result.stderr).toContain(repairRequest.expectedReportSetHash);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.url).toBe(`/pods/${podId}/repair-continuation-v1`);
    } finally {
      await fixture.dispose();
    }
  });
  it('invalid selection fails before any request in the real executable', async () => {
    const fixture = await createCliFixture({ body: {} });
    try {
      const result = await fixture.start([
        'repair-continuation',
        podId,
        '--apply',
        '--observe',
        repairRequest.id,
      ]).result;
      expect(result.code).toBe(1);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });
});
