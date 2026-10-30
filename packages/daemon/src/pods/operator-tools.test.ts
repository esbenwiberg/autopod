import { describe, expect, it, vi } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
describe('daemon credential and tool controls', () => {
  it('rejects source credential vending before any container write or install', async () => {
    const f = createOperatorFixture();
    await expect(f.tools().injectCredential('prepare', 'github')).rejects.toMatchObject({
      code: 'SOURCE_CREDENTIAL_INJECTION_DISABLED',
      statusCode: 410,
    });
    expect(f.cm.writeFile).not.toHaveBeenCalled();
    expect(f.toolsCaptured.installGhBinary).not.toHaveBeenCalled();
  });
  it('skips an existing tool and selects the original gh/az installers only when absent', async () => {
    const f = createOperatorFixture();
    await f.tools().installCliTool('prepare', 'gh');
    expect(f.toolsCaptured.installGhBinary).not.toHaveBeenCalled();
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    await f.tools().installCliTool('prepare', 'gh');
    const ghManager = f.toolsCaptured.installGhBinary.mock.calls[0]?.[0];
    if (!ghManager) throw new Error('Missing guarded gh manager');
    expect(f.toolsCaptured.installGhBinary).toHaveBeenCalledWith(
      ghManager,
      'container-123',
      'prepare',
    );
    await ghManager.execInContainer('container-123', ['gh-forwarding-proof']);
    expect(f.cm.execInContainer).toHaveBeenLastCalledWith('container-123', ['gh-forwarding-proof']);
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    await f.tools().installCliTool('prepare', 'az');
    const azManager = f.toolsCaptured.installAzViaPip.mock.calls[0]?.[0];
    if (!azManager) throw new Error('Missing guarded az manager');
    expect(f.toolsCaptured.installAzViaPip).toHaveBeenCalledWith(
      azManager,
      'container-123',
      'prepare',
    );
    await azManager.execInContainer('container-123', ['az-forwarding-proof']);
    expect(f.cm.execInContainer).toHaveBeenLastCalledWith('container-123', ['az-forwarding-proof']);
    const calls = vi.mocked(f.cm.execInContainer).mock.calls.length;
    f.podRepo.incrementLifecycleGeneration('prepare');
    expect(() => ghManager.execInContainer('container-123', ['stale-install'])).toThrow();
    expect(vi.mocked(f.cm.execInContainer).mock.calls).toHaveLength(calls);
  });
  it('rejects a stopped pod or missing container before installation', async () => {
    const f = createOperatorFixture();
    f.podRepo.update('prepare', { status: 'paused' });
    await expect(f.tools().installCliTool('prepare', 'gh')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.podRepo.update('prepare', { status: 'running', containerId: null });
    await expect(f.tools().installCliTool('prepare', 'az')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(f.toolsCaptured.installAzViaPip).not.toHaveBeenCalled();
  });
});
