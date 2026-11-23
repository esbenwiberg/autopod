import { environmentPresetSchema, executionSettingsSchema } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { testExecutionCapabilities } from '../test-utils/configuration-helpers.js';
import { sandboxCapabilities } from './backend-capabilities.js';
import { resolveExecution } from './resolve-execution.js';

const database = {
  id: 'db',
  type: 'postgres',
  image: `postgres@sha256:${'a'.repeat(64)}`,
  version: '17',
  port: 5432,
  startup: 'always',
};
const fixture = () => ({
  environment: environmentPresetSchema.parse({ template: 'node22', sidecars: [database] }),
  execution: executionSettingsSchema.parse({}),
  requiredSidecarIds: [] as string[],
  trustedRepository: false,
  capabilities: testExecutionCapabilities,
});
describe('execution admission', () => {
  it('freezes defaults and includes sidecar resources in the total', () => {
    const input = fixture();
    const result = resolveExecution(input);
    expect(result.main).toEqual({ memoryGb: 2, cpus: 1, storageGb: null });
    expect(result.sidecars.db?.memoryGb).toBe(1);
    expect(result.totalMemoryGb).toBe(3);
    expect(() =>
      resolveExecution({ ...input, capabilities: { ...input.capabilities, maxTotalMemoryGb: 2 } }),
    ).toThrow('combined');
  });
  it('attaches on-demand sidecars only when requested and rejects disabled or missing selections', () => {
    const input = fixture();
    input.environment.sidecars = input.environment.sidecars.map((s) => ({
      ...s,
      startup: 'on-demand',
    }));
    expect(resolveExecution(input).sidecars).toEqual({});
    expect(resolveExecution({ ...input, requiredSidecarIds: ['db'] }).sidecars.db).toBeDefined();
    expect(() => resolveExecution({ ...input, requiredSidecarIds: ['missing'] })).toThrow('absent');
    input.environment.sidecars = input.environment.sidecars.map((s) => ({
      ...s,
      startup: 'disabled',
    }));
    expect(() => resolveExecution({ ...input, requiredSidecarIds: ['db'] })).toThrow('disabled');
  });
  it('rejects unsupported sandbox size, independent CPU, storage and sidecars', () => {
    const input = fixture();
    input.execution.target = 'sandbox';
    input.capabilities = {
      ...input.capabilities,
      target: 'sandbox',
      maxMemoryGb: 4,
      maxTotalMemoryGb: 4,
      defaults: { memoryGb: 2, cpus: null, storageGb: null },
      maxCpus: null,
      maxTotalCpus: null,
      memoryTiersGb: [0.5, 1, 2, 4],
      sidecars: false,
    };
    expect(() => resolveExecution(input)).toThrow('sidecars');
    input.environment.sidecars = [];
    expect(resolveExecution(input).main.memoryGb).toBe(2);
    for (const memoryGb of [3, 8, 16])
      expect(() =>
        resolveExecution({
          ...input,
          execution: { ...input.execution, main: { ...input.execution.main, memoryGb } },
        }),
      ).toThrow();
    expect(() =>
      resolveExecution({
        ...input,
        execution: { ...input.execution, main: { ...input.execution.main, cpus: 1 } },
      }),
    ).toThrow('CPU');
    expect(() =>
      resolveExecution({
        ...input,
        execution: { ...input.execution, main: { ...input.execution.main, storageGb: 10 } },
      }),
    ).toThrow('storage');
  });
  describe('real hosted-sandbox capabilities', () => {
    const sandbox = (memoryGb?: number, extra: Record<string, number> = {}) => ({
      ...fixture(),
      environment: environmentPresetSchema.parse({ template: 'node22', sidecars: [] }),
      execution: executionSettingsSchema.parse({
        target: 'sandbox',
        main: { ...(memoryGb === undefined ? {} : { memoryGb }), ...extra },
      }),
      capabilities: sandboxCapabilities({ enabled: true, defaultTier: 'L' }),
    });

    it('freezes L for an omitted size and the exact XL/2XL/3XL bundle when selected', () => {
      expect(resolveExecution(sandbox()).main).toEqual({
        memoryGb: 4,
        cpus: null,
        storageGb: null,
      });
      expect(resolveExecution(sandbox(8)).main).toEqual({
        memoryGb: 8,
        cpus: null,
        storageGb: null,
      });
      expect(resolveExecution(sandbox(16)).main).toEqual({
        memoryGb: 16,
        cpus: null,
        storageGb: null,
      });
      expect(resolveExecution(sandbox(32)).main).toEqual({
        memoryGb: 32,
        cpus: null,
        storageGb: null,
      });
    });

    it.each([
      3, 6, 10, 24, 64,
    ])('rejects a non-advertised %s GB selection before admission', (gb) => {
      expect(() => resolveExecution(sandbox(gb))).toThrow(
        expect.objectContaining({ code: 'ALLOCATION_UNSUPPORTED' }),
      );
    });

    it('continues rejecting independent CPU or disk alongside a large bundle', () => {
      expect(() => resolveExecution(sandbox(16, { cpus: 8 }))).toThrow('CPU');
      expect(() => resolveExecution(sandbox(16, { storageGb: 160 }))).toThrow('storage');
    });

    it('re-resolves a frozen XL/2XL/3XL allocation identically and never downgrades it', () => {
      for (const gb of [8, 16, 32]) {
        const frozen = resolveExecution(sandbox(gb));
        // Recovery replays the frozen allocation as an explicit request.
        const replay = sandbox();
        replay.execution.main = frozen.main;
        expect(resolveExecution(replay)).toEqual(frozen);
        // A backend that no longer offers the bundle refuses rather than shrinking it.
        const shrunk = {
          ...replay,
          capabilities: {
            ...replay.capabilities,
            maxMemoryGb: 4,
            maxTotalMemoryGb: 4,
            memoryTiersGb: [0.5, 1, 2, 4],
          },
        };
        expect(() => resolveExecution(shrunk)).toThrow(
          expect.objectContaining({ code: 'ALLOCATION_UNSUPPORTED' }),
        );
      }
    });
  });
  it('requires both repository trust and host permission for Dagger', () => {
    const input = fixture();
    input.environment.sidecars = input.environment.sidecars.map((s) => ({
      ...s,
      type: 'dagger-engine',
    }));
    expect(() => resolveExecution(input)).toThrow('both');
    expect(() => resolveExecution({ ...input, trustedRepository: true })).toThrow('both');
    expect(() =>
      resolveExecution({
        ...input,
        capabilities: { ...input.capabilities, privilegedSidecars: true },
      }),
    ).toThrow('both');
    expect(
      resolveExecution({
        ...input,
        trustedRepository: true,
        capabilities: { ...input.capabilities, privilegedSidecars: true },
      }).sidecars.db,
    ).toBeDefined();
  });
});
