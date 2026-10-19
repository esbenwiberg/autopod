import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AZURE_DEVOPS_SCOPE, createAzureDevOpsAuth } from './azure-devops-auth.js';
import { getAzureToken, invalidateAzureToken } from './azure-token.js';

vi.mock('./azure-token.js', () => ({
  getAzureToken: vi.fn(),
  invalidateAzureToken: vi.fn(),
}));

describe('createAzureDevOpsAuth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the Azure DevOps Entra resource scope', async () => {
    vi.mocked(getAzureToken).mockResolvedValue({
      token: 'daemon-entra-token',
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(createAzureDevOpsAuth(pino({ enabled: false })).getToken()).resolves.toBe(
      'daemon-entra-token',
    );
    expect(getAzureToken).toHaveBeenCalledWith(AZURE_DEVOPS_SCOPE, expect.anything());
  });

  it('binds Azure DevOps token acquisition to the configured tenant', async () => {
    vi.mocked(getAzureToken).mockResolvedValue({
      token: 'daemon-entra-token',
      expiresAtMs: Date.now() + 60_000,
    });

    await createAzureDevOpsAuth(pino({ enabled: false }), {
      tenantId: 'ee357b2a-1bf9-42a6-baab-9772d85b28c1',
    }).getToken();

    expect(getAzureToken).toHaveBeenCalledWith(AZURE_DEVOPS_SCOPE, expect.anything(), {
      tenantId: 'ee357b2a-1bf9-42a6-baab-9772d85b28c1',
    });
  });

  it('invalidates the cached token for the same scope and tenant it acquires', () => {
    createAzureDevOpsAuth(pino({ enabled: false }), {
      tenantId: 'ee357b2a-1bf9-42a6-baab-9772d85b28c1',
    }).invalidate?.();

    expect(invalidateAzureToken).toHaveBeenCalledWith(AZURE_DEVOPS_SCOPE, {
      tenantId: 'ee357b2a-1bf9-42a6-baab-9772d85b28c1',
    });
  });
});
