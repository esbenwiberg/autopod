import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
import { createProvisioningToolInstallation } from './provisioning-tool-installation.js';
const fixtures: ReturnType<typeof createProvisioningFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});
describe('provisioning tool installation contracts', () => {
  it.each(['installGhBinary', 'installAzViaPip'] as const)(
    'passes the original root command and deadline to %s',
    async (method) => {
      const f = createProvisioningFixture();
      fixtures.push(f);
      const owner = createProvisioningToolInstallation({ logger: f.deps.logger });
      expect(f.cm.execInContainer).not.toHaveBeenCalled();
      await owner[method](f.cm, 'container', 'prepare');
      expect(f.cm.execInContainer).toHaveBeenCalledExactlyOnceWith(
        'container',
        expect.arrayContaining(['sh', '-c']),
        { timeout: method === 'installGhBinary' ? 120000 : 300000, user: 'root' },
      );
    },
  );
  it.each(['installGhBinary', 'installAzViaPip'] as const)(
    'retains a bounded diagnostic for nonzero %s',
    async (method) => {
      const f = createProvisioningFixture();
      fixtures.push(f);
      vi.mocked(f.cm.execInContainer).mockResolvedValueOnce({
        stdout: 'a'.repeat(500),
        stderr: 'tail-diagnostic',
        exitCode: 1,
      });
      const owner = createProvisioningToolInstallation({ logger: f.deps.logger });
      await expect(owner[method](f.cm, 'container', 'prepare')).rejects.toThrow('tail-diagnostic');
    },
  );
});
