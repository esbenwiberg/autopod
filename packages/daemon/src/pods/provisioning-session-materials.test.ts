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

describe('provisioning session materials', () => {
  it('writes the credential guard through the real git-dir lookup before automatic materials', async () => {
    const f = fixture();
    const result = await f.session();
    expect(result.kind).toBe('ready');
    expect(f.cm.writeFile).toHaveBeenCalledWith(
      'container-123',
      '/tmp/pre-commit',
      expect.stringContaining('ClearTextPassword'),
    );
    expect(f.cm.execInContainer).toHaveBeenCalledWith(
      'container-123',
      expect.arrayContaining([expect.stringContaining('git -C /workspace rev-parse --git-dir')]),
      { timeout: 5_000 },
    );
    expect(f.run.finishStartup).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('merges interactive MCP discovery with the repository config and halts after shared material', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { options: { ...f.pod().options, agentMode: 'interactive' } });
    await f.population();
    vi.mocked(f.cm.readFile).mockImplementation(async (_id, path) =>
      path === '/workspace/.mcp.json'
        ? JSON.stringify({ mcpServers: { repository: { command: 'existing-tool' } }, custom: true })
        : 'existing bashrc',
    );
    expect(await f.session()).toEqual({ kind: 'halted' });
    const mcp = vi
      .mocked(f.cm.writeFile)
      .mock.calls.find((call) => call[1] === '/workspace/.mcp.json');
    expect(JSON.parse(String(mcp?.[2] ?? '{}'))).toMatchObject({
      custom: true,
      mcpServers: { repository: { command: 'existing-tool' }, escalation: expect.any(Object) },
    });
    const paths = vi.mocked(f.cm.writeFile).mock.calls.map((call) => call[1]);
    expect(paths).toContain('/tmp/pre-commit');
    expect(paths).toContain('/home/autopod/.config/autopod/tools.md');
    expect(f.run.finishStartup).toHaveBeenCalledExactlyOnceWith('pass');
  });
  it('propagates shared hook write failure without claiming startup success', async () => {
    const f = fixture();
    await f.population();
    const failure = new Error('File transport unavailable');
    vi.mocked(f.cm.writeFile).mockRejectedValueOnce(failure);
    await expect(f.session()).rejects.toBe(failure);
    expect(f.run.finishStartup).not.toHaveBeenCalled();
  });
});
