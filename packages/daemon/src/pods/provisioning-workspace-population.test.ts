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
