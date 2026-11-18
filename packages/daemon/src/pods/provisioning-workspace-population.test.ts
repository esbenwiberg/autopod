import { AutopodError } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';

const fixtures: ReturnType<typeof createProvisioningFixture>[] = [];
function fixture() {
  const f = createProvisioningFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('provisioning workspace population', () => {
  it.each([
    'local',
    'sandbox',
  ] as const)('uses backend-specific setup budgets without shortening the workspace copy on %s', async (target) => {
    const f = fixture();
    const prepared = await f.container();
    prepared.pod.executionTarget = target;
    vi.mocked(f.cm.execInContainer).mockClear();
    await f.population();
    const calls = vi.mocked(f.cm.execInContainer).mock.calls;
    const probe = calls.find((call) => call[1].join(' ').includes('ls-files | head -1'));
    expect(probe?.[2]?.timeout).toBe(target === 'sandbox' ? 60_000 : 5_000);
    const copy = calls.find((call) => call[1].join(' ').includes('/mnt/worktree'));
    expect(copy?.[2]?.timeout).toBe(120_000);
    if (target === 'sandbox') {
      expect(calls.length).toBeGreaterThan(5);
      for (const call of calls) expect(call[2]?.timeout).toBeGreaterThanOrEqual(60_000);
    }
  });
  it('pre-clears image Git metadata before mirror and standalone Git setup, then publishes the running container', async () => {
    const f = fixture();
    await f.container();
    vi.mocked(f.cm.execInContainer).mockClear();
    const result = await f.population();
    const commands = vi.mocked(f.cm.execInContainer).mock.calls.map((call) => call[1]);
    expect(commands[0]).toEqual(['rm', '-rf', '/workspace/.git']);
    expect(commands[1]?.join(' ')).toContain('/mnt/worktree');
    expect(commands.findIndex((cmd) => cmd.join(' ').includes('BARE_WT='))).toBeGreaterThan(1);
    expect(result.pod).toMatchObject({ status: 'running', containerId: 'container-123' });
    expect(f.pod().containerId).toBe('container-123');
  });
  it('does not replay an unobserved sandbox file-list probe or publish a running worker', async () => {
    const f = fixture();
    const prepared = await f.container();
    prepared.pod.executionTarget = 'sandbox';
    const unknown = new AutopodError('Unobserved probe exit', 'EXEC_EXIT_UNVERIFIED', 409);
    const original = vi.mocked(f.cm.execInContainer).getMockImplementation();
    vi.mocked(f.cm.execInContainer).mockImplementation(async (...args) => {
      if (args[1].join(' ').includes('ls-files | head -1')) throw unknown;
      if (!original) throw new Error('Missing base mock');
      return original(...args);
    });
    await expect(f.population()).rejects.toBe(unknown);
    expect(
      vi
        .mocked(f.cm.execInContainer)
        .mock.calls.filter((call) => call[1].join(' ').includes('ls-files | head -1')),
    ).toHaveLength(1);
    expect(f.pod().status).toBe('provisioning');
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('fails closed on workspace pre-clear without publishing a running container', async () => {
    const f = fixture();
    await f.container();
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce({
      exitCode: 7,
      stdout: '',
      stderr: 'protected',
    });
    await expect(f.population()).rejects.toThrow('Workspace pre-clear failed (exit 7): protected');
    expect(f.pod()).toMatchObject({ status: 'provisioning', containerId: null });
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('preserves the container and rejects a failed standalone Git setup before running publication', async () => {
    const f = fixture();
    await f.container();
    const original = vi.mocked(f.cm.execInContainer).getMockImplementation();
    vi.mocked(f.cm.execInContainer).mockImplementation(async (...args) => {
      if (args[1].join(' ').includes('BARE_WT='))
        return { exitCode: 9, stdout: '', stderr: 'bad gitlink' };
      if (!original) throw new Error('Missing base mock');
      return original(...args);
    });
    await expect(f.population()).rejects.toThrow(
      'Git workspace setup failed (exit 9): bad gitlink',
    );
    expect(f.pod().status).toBe('provisioning');
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
});
