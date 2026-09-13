import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManagedRecord } from '../managed-protocol.js';
import * as protocol from './managed-pod.js';

const examples = JSON.parse(
  readFileSync(new URL('../../../../specs/managed-pod/v1/examples.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;

describe('managed pod v1 producer contract', () => {
  for (const [name, value] of Object.entries(examples)) {
    const schema = protocol[`${name}Schema` as keyof typeof protocol];
    it(`${name} validates and rejects unknown fields and versions`, () => {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, apiKey: 'synthetic' }).success).toBe(false);
      if ('schemaVersion' in value) {
        expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
      }
    });
  }
  it('rejects credential values in allowed text fields', () => {
    const example = examples.ManagedPodRequest;
    expect(example).toBeDefined();
    if (!example) throw new Error('missing-managed-pod-request-example');
    for (const objective of [
      'Bearer synthetic-token',
      'ghp_synthetic0000',
      'https://user:password@example.test/repo',
    ]) {
      const request = structuredClone(example);
      (request.task as Record<string, unknown>).objective = objective;
      expect(protocol.ManagedPodRequestSchema.safeParse(request).success).toBe(false);
      expect(() => parseManagedRecord('ManagedPodRequestSchema', request)).toThrow(
        'invalid-managed-contract',
      );
    }
  });
  it('accepts a duration-bounded agent grant above the old 100-request ceiling', () => {
    const example = examples.ManagedPodRequest;
    expect(example).toBeDefined();
    if (!example) throw new Error('missing-managed-pod-request-example');
    const request = structuredClone(example);
    const profile = request.profileSnapshot as Record<string, unknown>;
    const grant = request.effectiveGrant as Record<string, unknown>;
    profile.budget = {
      mode: 'request-time',
      expiresAt: 4102444800,
      maxProviderRequests: 500,
      maxDurationSeconds: 1800,
    };
    grant.budget = structuredClone(profile.budget);
    expect(protocol.ManagedPodRequestSchema.safeParse(request).success).toBe(true);
  });
  it('accepts result telemetry above the old 100-request ceiling', () => {
    const example = examples.ManagedObservation;
    expect(example).toBeDefined();
    if (!example) throw new Error('missing-managed-observation-example');
    const observation = structuredClone(example);
    (observation.result as Record<string, unknown>).providerRequests = 500;
    expect(protocol.ManagedObservationSchema.safeParse(observation).success).toBe(true);
  });
});
