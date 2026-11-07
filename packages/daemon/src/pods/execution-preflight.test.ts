import type { ExecutionRequirements, Pod, Profile } from '@autopod/shared';
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
it('records unresolved dynamic shell commands as advisory evidence and retains incomplete-discovery evidence after declaration', async () => {
  const cm = createMockContainerManager();
  const dynamic = { ...profile, testCommand: '$RUNNER test' };
  const advisory = await inspectExecutionPreflight(cm, 'container', pod, dynamic);
  expect(advisory.status).toBe('checked');
  expect(advisory.commands.unresolvedSources).toEqual(['profile.test']);
  const recommendation = advisory.diagnostics.find(
    (item) => item.code === 'COMMAND_DECLARATION_RECOMMENDED',
  );
  expect(recommendation?.detail).toContain('profile.test');
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

it('starts a pod whose profile commands use ordinary shell structure', async () => {
  const result = await inspectExecutionPreflight(createMockContainerManager(), 'container', pod, {
    ...profile,
    buildCommand: 'dotnet build Api/Api.csproj && cd Client && npm ci && npm run build',
    startCommand: 'node server.js --port "$PORT"',
  } as Profile);
  expect(result.status).toBe('checked');
  expect(result.diagnostics.map((item) => item.code)).not.toContain(
    'PREFLIGHT_COMMAND_UNAVAILABLE',
  );
});
/** Replace only the launcher probe; every other exec keeps its mock behaviour. */
function withProbeResult(probe: { stdout: string; stderr: string; exitCode: number }) {
  const cm = createMockContainerManager();
  const original = cm.execInContainer;
  cm.execInContainer = vi.fn(async (containerId: string, command: string[], options?: unknown) =>
    command[2]?.includes('autopod-command-preflight-v1')
      ? probe
      : (original as (...args: unknown[]) => Promise<typeof probe>)(containerId, command, options),
  ) as typeof cm.execInContainer;
  return cm;
}
it('blocks a proven-missing launcher but not an unverifiable probe', async () => {
  const blocked = await inspectExecutionPreflight(
    withProbeResult({
      stdout: JSON.stringify([{ executable: 'npm', available: false }]),
      stderr: '',
      exitCode: 0,
    }),
    'container',
    pod,
    { ...profile, testCommand: 'npm test' } as Profile,
  );
  expect(blocked.status).toBe('blocked');
  expect(blocked.diagnostics.map((item) => item.code)).toContain('PREFLIGHT_COMMAND_UNAVAILABLE');

  // No `node` in the image, or a timed-out probe: unknown must not fail the pod.
  const advisory = await inspectExecutionPreflight(
    withProbeResult({ stdout: '', stderr: 'node: not found', exitCode: 127 }),
    'container',
    pod,
    { ...profile, testCommand: 'npm test' } as Profile,
  );
  expect(advisory.status).toBe('checked');
  expect(advisory.diagnostics.map((item) => item.code)).toContain(
    'COMMAND_AVAILABILITY_UNVERIFIED',
  );
});

function requiring(requirements: ExecutionRequirements): Pod {
  return {
    ...pod,
    contract: {
      contractVersion: 1,
      title: 'Execution',
      dependsOn: [],
      scenarios: [],
      requiredFacts: [],
      humanReview: [],
      executionRequirements: requirements,
    },
  };
}

it.each([
  false,
  null,
])('blocks a v2 explicit launcher that is %s without changing v1', async (available) => {
  const cm = withProbeResult({
    stdout: JSON.stringify([{ executable: 'node', available }]),
    stderr: '',
    exitCode: 0,
  });
  const strict = await inspectExecutionPreflight(
    cm,
    'container',
    requiring({ version: 2, executables: ['node'] }),
    profile,
  );
  expect(strict.status).toBe('blocked');
  expect(strict.commands.requirements[0]?.available).toBe(available);
  expect(strict.diagnostics.map((item) => item.code)).toContain(
    available === false ? 'PREFLIGHT_COMMAND_UNAVAILABLE' : 'PREFLIGHT_COMMAND_UNVERIFIED',
  );
  const legacy = await inspectExecutionPreflight(
    cm,
    'container',
    requiring({ version: 1, executables: ['node'] }),
    profile,
  );
  expect(legacy.status).toBe(available === false ? 'blocked' : 'checked');
});

it.each([
  { stdout: '', stderr: 'node: not found', exitCode: 127 },
  { stdout: 'malformed', stderr: '', exitCode: 0 },
  { stdout: JSON.stringify([{ executable: 'other', available: true }]), stderr: '', exitCode: 0 },
])('never qualifies an explicit v2 launcher from unusable probe output: %j', async (probe) => {
  const result = await inspectExecutionPreflight(
    withProbeResult(probe),
    'container',
    requiring({ version: 2, executables: ['node'] }),
    profile,
  );
  expect(result.status).toBe('blocked');
  expect(result.commands.requirements).toContainEqual({
    source: 'contract.executionRequirements',
    executable: 'node',
    available: null,
  });
});

it('blocks strict unknowns on a thrown probe timeout while inferred commands remain advisory', async () => {
  const cm = createMockContainerManager();
  const original = cm.execInContainer;
  cm.execInContainer = vi.fn(async (id, args, options) => {
    if (args[2]?.includes('autopod-command-preflight-v1')) throw new Error('Probe timed out');
    return original(id, args, options);
  });
  const strict = await inspectExecutionPreflight(
    cm,
    'container',
    requiring({ version: 2, executables: ['node'] }),
    profile,
  );
  expect(strict.status).toBe('blocked');
  const inferred = await inspectExecutionPreflight(
    cm,
    'container',
    requiring({ version: 2, executables: [] }),
    { ...profile, testCommand: 'npm test' },
  );
  expect(inferred.status).toBe('checked');
  expect(inferred.diagnostics.map((item) => item.code)).toContain(
    'COMMAND_AVAILABILITY_UNVERIFIED',
  );
});

it('keeps v2 inferred missing and dynamic commands advisory without suppressing validation', async () => {
  const result = await inspectExecutionPreflight(
    withProbeResult({
      stdout: JSON.stringify([
        { executable: 'node', available: true },
        { executable: 'npm', available: false },
      ]),
      stderr: '',
      exitCode: 0,
    }),
    'container',
    requiring({ version: 2, executables: ['node'] }),
    {
      ...profile,
      buildCommand: 'npm run build',
      testCommand: '$RUNNER test',
    },
  );
  expect(result.status).toBe('checked');
  expect(result.commands.unresolvedSources).toEqual(['profile.test']);
  expect(result.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining(['INFERRED_COMMAND_UNAVAILABLE', 'COMMAND_DISCOVERY_PARTIAL']),
  );
});

it('keeps actual unknown image/resource metadata diagnostic and blocks explicit unknown resources', async () => {
  const cm = createMockContainerManager();
  const result = await inspectExecutionPreflight(
    cm,
    'container',
    requiring({ version: 2, executables: ['node'] }),
    profile,
  );
  expect(result.status).toBe('checked');
  expect(result.imageDigest).toBeNull();
  expect(result.capabilities.memoryLimitBytes).toBeNull();
  expect(result.capabilities.cpuLimit).toBeNull();
  expect(result.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining(['IMAGE_IDENTITY_UNAVAILABLE', 'MEMORY_CAPACITY_UNVERIFIED']),
  );
  const required = await inspectExecutionPreflight(
    cm,
    'container',
    requiring({ version: 2, executables: [], minimumMemoryBytes: 1024 ** 3, minimumCpu: 1 }),
    profile,
  );
  expect(required.status).toBe('blocked');
  expect(required.diagnostics.map((item) => item.code)).toContain(
    'PREFLIGHT_RESOURCE_REQUIREMENT_UNVERIFIED',
  );
});

it('does not reuse previous image/resource success after metadata becomes unavailable', async () => {
  const cm = createMockContainerManager();
  cm.getExecutionMetadata = vi
    .fn()
    .mockResolvedValueOnce({
      imageDigest: `sha256:${'a'.repeat(64)}`,
      memoryLimitBytes: 8 * 1024 ** 3,
      cpuLimit: 2,
      networkMode: 'isolated',
    })
    .mockRejectedValueOnce(new Error('Backend inspection unavailable'));
  const task = requiring({
    version: 2,
    executables: [],
    minimumMemoryBytes: 1024 ** 3,
    minimumCpu: 1,
  });
  const previous = await inspectExecutionPreflight(cm, 'original-container', task, profile);
  expect(previous.status).toBe('checked');
  expect(previous.imageDigest).toBe(`sha256:${'a'.repeat(64)}`);
  const current = await inspectExecutionPreflight(cm, 'replacement-container', task, profile);
  expect(current.status).toBe('blocked');
  expect(current.imageDigest).toBeNull();
  expect(current.capabilities.memoryLimitBytes).toBeNull();
  expect(current.capabilities.cpuLimit).toBeNull();
  expect(current.diagnostics.map((item) => item.code)).toContain(
    'PREFLIGHT_RESOURCE_REQUIREMENT_UNVERIFIED',
  );
});

it('does not accept an image-build requirement based on successful executable probes', async () => {
  const result = await inspectExecutionPreflight(
    createMockContainerManager(),
    'container',
    requiring({ version: 2, executables: ['docker'], requiresImageBuild: true }),
    profile,
  );
  expect(result.commands.requirements[0]?.available).toBe(true);
  expect(result.status).toBe('blocked');
  expect(result.diagnostics.map((item) => item.code)).toContain(
    'PREFLIGHT_IMAGE_BUILD_UNSUPPORTED',
  );
});

it.each([
  { platform: 'darwin/arm64' as const },
  { requiredReferenceRepositories: [{ repositoryId: 'works', commitSha: 'a'.repeat(40) }] },
])('requires frozen admission rather than guessing legacy platform/reference qualification: %j', async (requirement) => {
  const result = await inspectExecutionPreflight(
    createMockContainerManager(),
    'container',
    requiring({ version: 2, executables: [], ...requirement }),
    profile,
  );
  expect(result.status).toBe('blocked');
  expect(result.diagnostics.map((item) => item.code)).toContain(
    'PREFLIGHT_FROZEN_REQUIREMENTS_UNVERIFIED',
  );
});

it.each([
  'review',
  'completion',
] as const)('does not impose v2 worker prerequisites on %s', async (purpose) => {
  const result = await inspectExecutionPreflight(
    createMockContainerManager(),
    'container',
    requiring({
      version: 2,
      executables: ['missing'],
      minimumMemoryBytes: 1024 ** 3,
      minimumCpu: 8,
      requiresImageBuild: true,
      platform: 'darwin/arm64',
    }),
    profile,
    purpose,
    purpose === 'review' ? 'reviewer' : 'worker',
  );
  expect(result.status).toBe('checked');
  expect(result.commands.requirements).toEqual([]);
  expect(
    result.diagnostics.map((item) => item.code).filter((code) => code.startsWith('PREFLIGHT_')),
  ).toEqual([]);
});

it('applies v2 strict launchers during worker validation as well as coding', async () => {
  const result = await inspectExecutionPreflight(
    withProbeResult({ stdout: '', stderr: '', exitCode: 1 }),
    'container',
    requiring({ version: 2, executables: ['node'] }),
    profile,
    'validation',
  );
  expect(result.status).toBe('blocked');
  expect(result.diagnostics.map((item) => item.code)).toContain('PREFLIGHT_COMMAND_UNVERIFIED');
});
