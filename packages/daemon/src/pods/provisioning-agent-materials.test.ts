import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
import { createProvisioningAgentMaterials } from './provisioning-agent-materials.js';
import { AGENT_ENV_PATH, AGENT_SHIM_PATH } from './provisioning-runtime-files.js';
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

describe('provisioning agent materials', () => {
  for (const target of ['local', 'sandbox'] as const) {
    it(`writes ${target} secret/shim modes and returns prepared dispatch references`, async () => {
      const f = fixture();
      const session = await f.session();
      if (session.kind !== 'ready') throw new Error('Unexpected halt');
      const result = await createProvisioningAgentMaterials(
        f.deps,
        f.captured,
      ).prepareAgentMaterials({
        ...session,
        pod: { ...session.pod, executionTarget: target },
      });
      expect(result.containerManager).toBe(f.cm);
      expect(result.profile).toBe(session.profile);
      expect(result.containerId).toBe(session.containerId);
      expect(f.cm.execInContainer).toHaveBeenCalledWith(
        'container-123',
        ['chmod', target === 'local' ? '0400' : '0444', AGENT_ENV_PATH],
        { timeout: 5_000 },
      );
      expect(f.cm.execInContainer).toHaveBeenCalledWith(
        'container-123',
        ['chmod', target === 'local' ? '0500' : '0555', AGENT_SHIM_PATH],
        { timeout: 5_000 },
      );
      expect(result.secretEnv).toMatchObject({ POD_ID: 'prepare' });
      expect(result.systemInstructions).toContain('Original task');
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    });
  }
  it('propagates credential file transport failure before instructions or dispatch', async () => {
    const f = fixture();
    await f.session();
    const original = vi.mocked(f.cm.writeFile).getMockImplementation();
    const failure = new Error('Secret transport failed');
    vi.mocked(f.cm.writeFile).mockImplementation(async (...args) => {
      if (args[1] === AGENT_ENV_PATH) throw failure;
      return original?.(...args);
    });
    await expect(f.agent()).rejects.toBe(failure);
    expect(vi.mocked(f.cm.writeFile).mock.calls.some((call) => call[1] === AGENT_SHIM_PATH)).toBe(
      false,
    );
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.run.finishStartup).not.toHaveBeenCalled();
  });
});
