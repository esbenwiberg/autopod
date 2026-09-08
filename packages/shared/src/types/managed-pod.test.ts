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
    for (const objective of [
      'Bearer synthetic-token',
      'ghp_synthetic0000',
      'https://user:password@example.test/repo',
    ]) {
      const request = structuredClone(examples.ManagedPodRequest!);
      (request.task as Record<string, unknown>).objective = objective;
      expect(protocol.ManagedPodRequestSchema.safeParse(request).success).toBe(false);
      expect(() => parseManagedRecord('ManagedPodRequestSchema', request)).toThrow(
        'invalid-managed-contract',
      );
    }
  });
});
