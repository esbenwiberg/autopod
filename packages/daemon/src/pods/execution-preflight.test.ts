import type { Pod, Profile } from '@autopod/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { inspectExecutionPreflight } from './execution-preflight.js';

const pod = { runtime: 'claude', model: 'test', options: { validate: true } } as Pod;
const profile = { containerMemoryGb: 4 } as Profile;
afterEach(() => vi.useRealTimers());
it('blocks known insufficient memory and unknown explicitly required CPU without pretending metadata is verified', async () => {
  const cm = createMockContainerManager();
  cm.getExecutionMetadata = vi.fn().mockResolvedValue({
    imageDigest: 'mutable-tag',
    memoryLimitBytes: 2 * 1024 ** 3,
    cpuLimit: null,
    networkMode: null,
  });
  const result = await inspectExecutionPreflight(
    cm,
    'container',
    {
      ...pod,
      contract: { executionRequirements: { version: 1, executables: ['node'], minimumCpu: 2 } },
    } as Pod,
    profile,
  );
  expect(result.status).toBe('blocked');
  expect(result.imageDigest).toBeNull();
  expect(result.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining([
      'PREFLIGHT_INSUFFICIENT_MEMORY',
      'PREFLIGHT_RESOURCE_REQUIREMENT_UNVERIFIED',
    ]),
  );
});
it('requires explicit dependencies for dynamic shell commands and retains incomplete-discovery evidence after declaration', async () => {
  const cm = createMockContainerManager();
  const dynamic = { ...profile, testCommand: '$RUNNER test' };
  const blocked = await inspectExecutionPreflight(cm, 'container', pod, dynamic);
  expect(blocked.status).toBe('blocked');
  expect(blocked.diagnostics.map((item) => item.code)).toContain(
    'PREFLIGHT_COMMAND_DECLARATION_REQUIRED',
  );
  const declared = await inspectExecutionPreflight(
    cm,
    'container',
    {
      ...pod,
      contract: { executionRequirements: { version: 1, executables: ['node'] } },
    } as Pod,
    dynamic,
  );
  expect(declared.status).toBe('checked');
  expect(declared.commands.requirements).toContainEqual({
    source: 'contract.executionRequirements',
    executable: 'node',
    available: true,
  });
  expect(declared.diagnostics.map((item) => item.code)).toContain('COMMAND_DISCOVERY_PARTIAL');
});
it('does not require unused profile validation launchers for report-only work', async () => {
  const result = await inspectExecutionPreflight(
    createMockContainerManager(),
    'container',
    {
      ...pod,
      options: { ...pod.options, validate: false },
    },
    { ...profile, testCommand: '$UNUSED_RUNNER test' },
  );
  expect(result.status).toBe('checked');
  expect(result.commands.unresolvedSources).toEqual([]);
});
it('bounds an unavailable metadata backend and preserves unknown values', async () => {
  vi.useFakeTimers();
  const cm = createMockContainerManager();
  cm.getExecutionMetadata = vi.fn(() => new Promise<never>(() => {}));
  let completed = false;
  const pending = inspectExecutionPreflight(cm, 'container', pod, profile).then((result) => {
    completed = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(15001);
  expect(completed).toBe(true);
  const result = await pending;
  expect(result.capabilities.memoryLimitBytes).toBeNull();
  expect(result.diagnostics.map((item) => item.code)).toContain('ENVIRONMENT_METADATA_UNAVAILABLE');
});
