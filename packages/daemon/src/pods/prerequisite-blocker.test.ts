import type {
  EffectiveLaunchConfig,
  EscalationRequest,
  ExecutionRequirements,
} from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import {
  assertRepairableExecutionRequirements,
  inspectRepairPrerequisiteReports,
  validatePrerequisiteBlocker,
} from './prerequisite-blocker.js';

const requirements: ExecutionRequirements = { version: 2, executables: ['jq', 'node'] };
const original = {
  work: { contract: { executionRequirements: requirements } },
} as EffectiveLaunchConfig;
function report(id = 'report'): EscalationRequest {
  return {
    id,
    podId: 'pod',
    type: 'report_blocker',
    timestamp: '2026-01-01T00:00:00.000Z',
    response: null,
    payload: {
      kind: 'infrastructure',
      owner: 'autopod',
      phase: 'coding',
      lifecycleGeneration: 2,
      requiresResponse: false,
      description: 'Declared jq launcher missing',
      attempted: ['lookup'],
      needs: 'jq launcher',
      prerequisiteBlocker: {
        version: 1,
        kind: 'missing-execution-prerequisites',
        requirementsHash: configurationDigest(requirements),
        launchers: ['jq'],
      },
    },
  };
}
describe('prospective typed prerequisite blockers', () => {
  it('validates original v2 hash and every explicit launcher without accepting a fixed claim', () => {
    const input = report().payload;
    if (!('prerequisiteBlocker' in input)) throw new Error('fixture');
    expect(validatePrerequisiteBlocker(input.prerequisiteBlocker, requirements)).toEqual(
      input.prerequisiteBlocker,
    );
    for (const patch of [
      { requirementsHash: 'f'.repeat(64) },
      { launchers: ['undeclared'] },
      { resolved: true },
      { receipt: 'success' },
      { launchers: [] },
      { launchers: ['node', 'node'] },
    ])
      expect(() =>
        validatePrerequisiteBlocker({ ...input.prerequisiteBlocker, ...patch }, requirements),
      ).toThrow();
  });
  it.each([
    undefined,
    { version: 1, executables: ['jq'] },
    { version: 2, executables: ['docker'] },
    { version: 2, executables: ['jq'], requiresImageBuild: true },
    { version: 2, executables: ['swift'] },
    { version: 2, executables: ['jq'], platform: 'darwin/arm64' },
    { version: 2, executables: ['./script'] },
  ])('refuses unsupported requirement %j', (input) => {
    expect(() => assertRepairableExecutionRequirements(input as ExecutionRequirements)).toThrow(
      /only explicit v2/,
    );
  });
  it('hashes complete canonical reports, independent of result hash, preserving text and deterministic ordering', () => {
    const a = report('a');
    const b = report('b');
    const first = inspectRepairPrerequisiteReports([a, b], original, 2);
    expect(inspectRepairPrerequisiteReports([b, a], original, 2)).toEqual(first);
    const changed = report('b');
    if ('needs' in changed.payload) changed.payload.needs = 'unchanged launcher, changed report';
    expect(inspectRepairPrerequisiteReports([a, changed], original, 2).reportSetHash).not.toBe(
      first.reportSetHash,
    );
    expect(first.launchers).toEqual(['jq']);
    expect(first.requirementsHash).toBe(configurationDigest(requirements));
    expect(a.payload).toEqual(report('a').payload);
  });
  it('refuses empty, mixed, stale, answered, duplicate or oversized report sets', () => {
    const untyped = report('legacy');
    if ('prerequisiteBlocker' in untyped.payload) delete untyped.payload.prerequisiteBlocker;
    const stale = report('stale');
    if ('lifecycleGeneration' in stale.payload) stale.payload.lifecycleGeneration = 1;
    const large = report('large');
    if ('needs' in large.payload) large.payload.needs = 'n'.repeat(65537);
    const answered = {
      ...report('answered'),
      response: { response: 'fixed', respondedBy: 'human', timestamp: '2026-01-01T00:00:00.000Z' },
    } as EscalationRequest;
    for (const reports of [
      [],
      [report(), untyped],
      [stale],
      [large],
      [answered],
      [report(), report()],
      Array.from({ length: 101 }, (_, i) => report(`r${i}`)),
    ])
      expect(() => inspectRepairPrerequisiteReports(reports, original, 2)).toThrow();
  });
});
