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
    expect(f.toolsCaptured.installGhBinary).toHaveBeenCalledWith(f.cm, 'container-123', 'prepare');
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    await f.tools().installCliTool('prepare', 'az');
    expect(f.toolsCaptured.installAzViaPip).toHaveBeenCalledWith(f.cm, 'container-123', 'prepare');
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
