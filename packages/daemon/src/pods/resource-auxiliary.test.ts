import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceFixture } from '../test-utils/resource-helpers.js';
import { createResourceAuxiliary } from './resource-auxiliary.js';
const transport = vi.hoisted(() =>
  vi.fn(
    async (
      _command: string,
      _args: string[],
      _options: { env?: NodeJS.ProcessEnv; timeout?: number },
    ) => ({ stdout: '', stderr: '' }),
  ),
);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: transport }) };
});
beforeEach(() => transport.mockClear());
describe('resource sidecar and test branch cleanup', () => {
  it('settles all sidecars, retains strict failures and honors metadata retention', async () => {
    const f = createResourceFixture();
    f.podRepo.update('prepare', { sidecarContainerIds: { db: 'one', cache: 'two' } });
    f.sidecars.kill.mockRejectedValueOnce(new Error('Synthetic sidecar'));
    await expect(f.auxiliary().killSidecarsForPod('prepare', true)).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(f.sidecars.kill).toHaveBeenCalledTimes(2);
    expect(f.pod().sidecarContainerIds).toEqual({ db: 'one', cache: 'two' });
    const guard = vi.fn();
    await f.auxiliary().killSidecarsForPod('prepare', true, guard, true);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(f.pod().sidecarContainerIds).toEqual({ db: 'one', cache: 'two' });
    await f.auxiliary().killSidecarsForPod('prepare');
    expect(f.pod().sidecarContainerIds).toBeNull();
  });
  it('rejects unavailable strict capability and checks ownership before metadata release', async () => {
    const f = createResourceFixture();
    f.podRepo.update('prepare', { sidecarContainerIds: { db: 'one' } });
    const absent = createResourceAuxiliary(f.live, {
      ...f.auxiliaryCaptured,
      sidecarManager: undefined,
    });
    await expect(absent.killSidecarsForPod('prepare', true)).rejects.toThrow(
      'capability unavailable',
    );
    const error = new Error('Synthetic ownership');
    const guard = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw error;
      });
    await expect(f.auxiliary().killSidecarsForPod('prepare', true, guard)).rejects.toBe(error);
    expect(f.pod().sidecarContainerIds).toEqual({ db: 'one' });
  });
  it('deletes a controlled HTTPS branch using live auth and persists cleared metadata through reopen', async () => {
    const f = createResourceFixture(true);
    const remote = 'https://dev.azure.com/org/project/_git/test';
    f.podRepo.update('prepare', { testRunBranches: ['operator-test'] });
    f.auxiliaryCaptured.executionForPod = () => ({
      ...f.passContext().profile,
      testPipeline: { enabled: true, testRepo: remote, testPipelineId: 1 },
    });
    const owner = f.auxiliary();
    const getToken = vi.fn(async () => 'synthetic-ado-token');
    f.live.azureDevOpsAuth = { getToken };
    const guard = vi.fn();
    await owner.cleanupTestRunBranches('prepare', { strict: true, assertCurrent: guard });
    expect(getToken).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith(
      'git',
      ['-C', f.directory, 'push', remote, '--delete', 'operator-test'],
      expect.objectContaining({
        timeout: 30000,
        env: expect.objectContaining({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }),
      }),
    );
    expect(f.pod().testRunBranches).toBeNull();
    const saved = f.pod();
    const profile = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('keeps strict branch metadata on failure and sanitizes provider error logging', async () => {
    const f = createResourceFixture();
    f.podRepo.update('prepare', { testRunBranches: ['branch'] });
    await expect(
      f.auxiliary().cleanupTestRunBranches('prepare', { strict: true, assertCurrent: () => {} }),
    ).rejects.toThrow('capability unavailable');
    f.auxiliaryCaptured.executionForPod = () => ({
      ...f.passContext().profile,
      testPipeline: {
        enabled: true,
        testRepo: 'https://dev.azure.com/org/project/_git/test',
        testPipelineId: 1,
      },
    });
    f.live.azureDevOpsAuth = { getToken: async () => 'synthetic-ado-token' };
    transport.mockRejectedValueOnce(new Error('Authorization: Bearer synthetic-ado-token'));
    await expect(
      f.auxiliary().cleanupTestRunBranches('prepare', { strict: true, assertCurrent: () => {} }),
    ).rejects.toThrow('incomplete');
    expect(f.pod().testRunBranches).toEqual(['branch']);
    expect(JSON.stringify(vi.mocked(f.deps.logger.warn).mock.calls)).not.toContain(
      'synthetic-ado-token',
    );
    await f.auxiliary().cleanupTestRunBranches('prepare');
    expect(f.pod().testRunBranches).toBeNull();
  });
});
