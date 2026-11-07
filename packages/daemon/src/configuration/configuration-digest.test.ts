import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonicalConfiguration, configurationDigest } from './configuration-digest.js';

// The native binding decoder intentionally supports only v1 binding primitives.
// Arrays/null/bools/resource floats are canonicalized here, but MUST be refused
// in that binding (resources are represented by executionContextHash, not floats).
const cases = [
  {
    name: 'nested-strings-safe-integers',
    bindingSubset: true,
    value: {
      z: 9007199254740991,
      a: { version: 1, originalGeneration: 0, candidateGeneration: 3 },
    },
    canonical:
      '{"a":{"candidateGeneration":3,"originalGeneration":0,"version":1},"z":9007199254740991}',
  },
  {
    name: 'utf16-order-and-unicode',
    bindingSubset: true,
    value: { '\ufffd': 'é', '😀': 'e\u0301', a: '中文/😀\u2028\u2029' },
    canonical: '{"a":"中文/😀\u2028\u2029","😀":"e\u0301","�":"é"}',
  },
  {
    name: 'escaping',
    bindingSubset: true,
    value: { resourceKey: 'docker://host/"quoted"\\\b\t\n\f\r\u0000\u0001\u001f' },
    canonical:
      '{"resourceKey":"docker://host/\\"quoted\\"\\\\\\b\\t\\n\\f\\r\\u0000\\u0001\\u001f"}',
  },
  {
    name: 'nested-array-null-bool',
    bindingSubset: false,
    value: { z: [null, true, false, { b: ['é', 2, 1], a: null }] },
    canonical: '{"z":[null,true,false,{"a":null,"b":["é",2,1]}]}',
  },
  {
    name: 'resource-floats',
    bindingSubset: false,
    value: { memoryGb: 0.5, cpus: 1.25, tiny: 1e-7, boundary: 1e-6, large: 1e21, negativeZero: -0 },
    canonical:
      '{"boundary":0.000001,"cpus":1.25,"large":1e+21,"memoryGb":0.5,"negativeZero":0,"tiny":1e-7}',
  },
  {
    name: 'bool-not-integer',
    bindingSubset: false,
    value: { version: true },
    canonical: '{"version":true}',
  },
  {
    name: 'null-not-object',
    bindingSubset: false,
    value: { source: null },
    canonical: '{"source":null}',
  },
  {
    name: 'fraction-not-generation',
    bindingSubset: false,
    value: { candidateGeneration: 1.5 },
    canonical: '{"candidateGeneration":1.5}',
  },
  {
    name: 'unsafe-integer',
    bindingSubset: false,
    value: { originalGeneration: 9007199254740992 },
    canonical: '{"originalGeneration":9007199254740992}',
  },
];
const fixtureURL = new URL(
  '../../../desktop/Tests/Fixtures/configuration-digest-vectors.json',
  import.meta.url,
);
describe('configuration digest cross-language wire identity', () => {
  it('pins canonical bytes and SHA-256, and records vectors only on explicit capture', async () => {
    const vectors = cases.map(({ value, ...vector }) => {
      expect(canonicalConfiguration(value)).toBe(vector.canonical);
      const digest = configurationDigest(value);
      expect(digest).toBe(createHash('sha256').update(vector.canonical, 'utf8').digest('hex'));
      return { ...vector, wire: JSON.stringify(value), digest };
    });
    // Different wire escaping/property order is the same JSON identity.
    vectors.push({
      name: 'alternate-wire-escaping',
      bindingSubset: true,
      wire: '{"resourceKey":"\\u00e9\\/\\ud83d\\ude00\\n","version":1.0}',
      canonical: '{"resourceKey":"é/😀\\n","version":1}',
      digest: configurationDigest({ resourceKey: 'é/😀\n', version: 1 }),
    });
    for (const v of vectors) expect(configurationDigest(JSON.parse(v.wire))).toBe(v.digest);
    if (process.env.REPAIR_DIGEST_FIXTURE === '1')
      await writeFile(fixtureURL, JSON.stringify(vectors, null, 2) + '\n');
    expect(JSON.parse(await readFile(fixtureURL, 'utf8'))).toEqual(vectors);
  });
});
