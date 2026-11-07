import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { canonicalConfiguration } from '../canonical-configuration.js';
import {
  repairContinuationOperationV1Schema,
  repairContinuationPreviewV1Schema,
  repairContinuationRequestV1Schema,
} from './repair-continuation.schema.js';

// Cross-language cases from the ACTUAL pinned schemas, applied to the committed
// real producer capture. No schema bounds or producer facts are changed.
type Case = {
  name: string;
  kind: 'request' | 'preview' | 'operation';
  path: string[];
  value: string;
  success: boolean;
  aliasKey?: string;
  retainOriginal?: boolean;
};
const cases: Case[] = [];
function add(kind: Case['kind'], field: string, name: string, value: string, success: boolean) {
  cases.push({ name, kind, path: field.split('.'), value, success });
}
for (const [name, unit] of [
  ['astral', '🧰'],
  ['combining', 'e\u0301'],
] as const) {
  for (const count of [9, 10, 4000, 4001]) {
    const value = Array.from(unit.repeat(count)).slice(0, count).join('');
    add('request', 'reason', `${name}-reason-${count}`, value, count >= 10 && count <= 4000);
  }
  for (const [kind, field, max] of [
    ['preview', 'configurationDiff.after.template', 128],
    ['operation', 'qualification.daemonCommit', 128],
    ['operation', 'refusals.0.message', 1024],
    ['operation', 'qualification.observations.0.detail', 1024],
    ['operation', 'qualification.binding.resourceKey', 2048],
    ['operation', 'qualification.binding.source.repository', 2048],
  ] as const) {
    for (const count of [0, 1, max, max + 1]) {
      const value = Array.from(unit.repeat(count)).slice(0, count).join('');
      add(
        kind,
        field,
        `${name}-${field}-${count}`,
        value,
        (count > 0 || field.endsWith('daemonCommit')) && count <= max,
      );
    }
  }
}
add(
  'operation',
  'qualification.binding.resourceKey',
  'review-resource-1025-astral',
  '🧰'.repeat(1025),
  true,
);
add('request', 'reason', 'review-reason-nine-codepoints', 'Fix 🧰 now', false);
for (const field of [
  'qualification.binding.resourceKey',
  'qualification.binding.source.repository',
]) {
  add('operation', field, `identity-is-not-trimmed-${field}`, '\ufeff /é/e\u0301/🧰\u0085 ', true);
}
for (const field of ['refusals.0.message', 'qualification.observations.0.detail']) {
  add('operation', field, `trimmed-text-max-${field}`, `\ufeff${'🧰'.repeat(1024)}\ufeff`, true);
  add('operation', field, `empty-after-trim-${field}`, '\ufeff', false);
  add('operation', field, `NEL-is-text-${field}`, '\u0085', true);
}
// Each exact ECMAScript whitespace scalar, including FEFF (Foundation differs).
const trimScalars = [
  9,
  10,
  11,
  12,
  13,
  32,
  160,
  5760,
  ...Array.from({ length: 11 }, (_, i) => 8192 + i),
  8232,
  8233,
  8239,
  8287,
  12288,
  65279,
];
for (const cp of trimScalars) {
  const unit = String.fromCodePoint(cp);
  add('request', 'reason', `trim-${cp}-valid`, `${unit}1234567890${unit}`, true);
  add('request', 'reason', `trim-${cp}-too-short`, `${unit}123456789${unit}`, false);
}
for (const cp of [0x85, 0x180e, 0x200b]) {
  const unit = String.fromCodePoint(cp);
  add('request', 'reason', `not-trim-${cp}`, `${unit}12345678${unit}`, true);
}
add('request', 'reason', 'trim-before-max', `\ufeff${'🧰'.repeat(4000)}\ufeff`, true);
add('request', 'reason', 'trim-only', '\ufeff\n\u00a0', false);
for (const [kind, field, max] of [
  ['request', 'id', 128],
  ['request', 'executionProfileId', 128],
  ['operation', 'qualification.observations.0.launcher', 256],
  ['operation', 'qualification.observations.0.code', 80],
] as const) {
  add(kind, field, `${field}-ascii-max`, 'A'.repeat(max), true);
  add(kind, field, `${field}-ascii-over`, 'A'.repeat(max + 1), false);
  add(kind, field, `${field}-non-ascii`, '🧰', false);
}
for (const [field, aliasKey, value] of [
  ['qualification.binding.resourceKey', 'resourceKey', 'alias-resource'],
  ['qualification.binding.source.repository', 'repositorKy', 'alias-repository'],
  ['qualification.binding.expectedImage.kind', 'Kind', 'docker-image-id'],
] as const) {
  cases.push({
    name: `key-alias-${field}`,
    kind: 'operation',
    path: field.split('.'),
    aliasKey,
    value,
    success: false,
  });
}
cases.push({
  name: 'coalescing-ascii-and-alias',
  kind: 'operation',
  path: ['qualification', 'binding', 'resourceKey'],
  aliasKey: 'resourceKey',
  retainOriginal: true,
  value: 'alias-resource',
  success: false,
});
function put(root: unknown, path: string[], value: unknown) {
  let node = root as Record<string, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path.at(-1)!] = value;
}
function get(root: unknown, path: string[]): unknown {
  return path.reduce((node, key) => (node as Record<string, unknown>)[key], root);
}
const fixtureURL = new URL(
  '../../../desktop/Tests/Fixtures/repair-continuation-strings.json',
  import.meta.url,
);
it('pins code-point bounds and ECMAScript trim through actual repair schemas for native consumers', async () => {
  const small = JSON.parse(
    await readFile(
      new URL('../../../desktop/Tests/Fixtures/repair-continuation-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const producer = JSON.parse(
    await readFile(
      new URL('../../../desktop/Tests/Fixtures/repair-continuation-backend.json', import.meta.url),
      'utf8',
    ),
  );
  const schemas = {
    request: repairContinuationRequestV1Schema,
    preview: repairContinuationPreviewV1Schema,
    operation: repairContinuationOperationV1Schema,
  };
  const vectors = cases.map((c) => {
    const wire = structuredClone(c.kind === 'operation' ? producer.validated : small[c.kind]);
    if (c.path[0] === 'refusals') wire.refusals = [{ code: 'unavailable', message: 'Before' }];
    put(wire, c.path, c.value);
    if (c.path.join('.') === 'qualification.binding.source.repository')
      wire.codingFinalSource.source.repository = c.value;
    if (c.aliasKey) {
      const parent = get(wire, c.path.slice(0, -1)) as Record<string, unknown>;
      if (!c.retainOriginal) delete parent[c.path.at(-1)!];
      parent[c.aliasKey] = c.value;
    }
    const parsed = schemas[c.kind].safeParse(wire);
    expect(parsed.success, c.name).toBe(c.success);
    // Pin the transformation, not just parser success; identities are never trimmed.
    const canonicalValue = parsed.success ? get(parsed.data, c.path) : null;
    if (parsed.success)
      expect(canonicalValue).toBe(
        c.path.at(-1) === 'reason' || c.path.at(-1) === 'message' || c.path.at(-1) === 'detail'
          ? c.value.trim()
          : c.value,
      );
    const bindingDigest =
      c.kind === 'operation'
        ? createHash('sha256')
            .update(canonicalConfiguration(wire.qualification.binding))
            .digest('hex')
        : null;
    return { ...c, canonicalValue, bindingDigest };
  });
  // Explicit opt-in capture; ordinary schema tests never rewrite fixtures.
  if (process.env.REPAIR_STRING_FIXTURE === '1')
    await writeFile(fixtureURL, `${JSON.stringify(vectors, null, 2)}\n`);
  expect(JSON.parse(await readFile(fixtureURL, 'utf8'))).toEqual(vectors);
});
