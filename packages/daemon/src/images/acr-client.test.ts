import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Azure SDK modules — must be before import
const mockGetToken = vi.fn().mockResolvedValue({ token: 'mock-token-xyz' });
const mockGetManifestProperties = vi.fn().mockResolvedValue({ digest: 'sha256:abc' });
const mockGetArtifact = vi.fn().mockReturnValue({
  getManifestProperties: mockGetManifestProperties,
});
const mockFetch = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken = mockGetToken;
  },
}));

vi.mock('@azure/container-registry', () => ({
  ContainerRegistryClient: class {
    getArtifact = mockGetArtifact;
  },
}));

// Import after mocks
import { AcrClient } from './acr-client.js';

function createMockDocker() {
  const followProgressCb = vi.fn(
    (
      _stream: unknown,
      onComplete: (err: Error | null) => void,
      onProgress?: (event: { aux?: { Digest?: string } }) => void,
    ) => {
      if (onProgress) {
        onProgress({ aux: { Digest: 'sha256:deadbeef' } });
      }
      onComplete(null);
    },
  );

  return {
    checkAuth: vi.fn().mockResolvedValue(undefined),
    getImage: vi.fn().mockReturnValue({
      tag: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue('mock-push-stream'),
    }),
    pull: vi.fn().mockResolvedValue('mock-pull-stream'),
    modem: { followProgress: followProgressCb },
  } as unknown as import('dockerode');
}

describe('AcrClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue({ token: tokenWithTenant('tenant-123') });
    mockGetManifestProperties.mockResolvedValue({ digest: 'sha256:abc' });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ refresh_token: 'mock-refresh-token' }),
      text: vi.fn().mockResolvedValue(''),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  it('pushes image to ACR', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    const digest = await client.push('autopod/test-app:latest');

    expect(digest).toBe('sha256:deadbeef');
    expect(mockDocker.checkAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        username: '00000000-0000-0000-0000-000000000000',
        password: 'mock-refresh-token',
        serveraddress: 'myregistry.azurecr.io',
      }),
    );
  });

  it('tags image for ACR before pushing', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    await client.push('autopod/test-app:latest');

    expect(mockDocker.getImage).toHaveBeenCalledWith('autopod/test-app:latest');
  });

  it('pulls image from ACR', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    await client.pull('autopod/test-app:latest');

    expect(mockDocker.pull).toHaveBeenCalledWith(
      'myregistry.azurecr.io/autopod/test-app:latest',
      expect.objectContaining({
        authconfig: expect.objectContaining({
          password: 'mock-refresh-token',
          serveraddress: 'myregistry.azurecr.io',
          username: '00000000-0000-0000-0000-000000000000',
        }),
      }),
    );
  });

  it('checks if image exists in ACR', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    const exists = await client.exists('autopod/test-app:latest');
    expect(exists).toBe(true);
    expect(mockGetArtifact).toHaveBeenCalledWith('autopod/test-app', 'latest');
  });

  it('checks fully qualified ACR image references', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    const exists = await client.exists('myregistry.azurecr.io/autopod/test-app:stable');
    expect(exists).toBe(true);
    expect(mockGetArtifact).toHaveBeenCalledWith('autopod/test-app', 'stable');
  });

  it('returns false when image does not exist', async () => {
    mockGetManifestProperties.mockRejectedValueOnce(new Error('Not found'));

    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    const exists = await client.exists('autopod/nonexistent:latest');
    expect(exists).toBe(false);
  });

  it('authenticates with Docker before push', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    await client.push('autopod/test-app:latest');

    expect(mockDocker.checkAuth).toHaveBeenCalled();
    const authCall = mockDocker.checkAuth.mock.invocationCallOrder[0];
    const getImageCall = mockDocker.getImage.mock.invocationCallOrder[0];
    expect(authCall).toBeLessThan(getImageCall);
  });

  it('requests an Azure Container Registry data-plane token for Docker auth', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    await client.push('autopod/test-app:latest');

    expect(mockGetToken).toHaveBeenCalledWith('https://containerregistry.azure.net/.default');
  });

  it('exchanges the Azure token for an ACR refresh token before Docker auth', async () => {
    const aadToken = tokenWithTenant('tenant-from-token');
    mockGetToken.mockResolvedValueOnce({ token: aadToken });
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    await client.push('autopod/test-app:latest');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://myregistry.azurecr.io/oauth2/exchange',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    const [, options] = mockFetch.mock.calls[0] as [string, { body: URLSearchParams }];
    expect(options.body.get('grant_type')).toBe('access_token');
    expect(options.body.get('service')).toBe('myregistry.azurecr.io');
    expect(options.body.get('tenant')).toBe('tenant-from-token');
    expect(options.body.get('access_token')).toBe(aadToken);
  });

  it('resolves local tags to fully qualified ACR references', () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    expect(client.resolveTag('autopod/test-app:latest')).toBe(
      'myregistry.azurecr.io/autopod/test-app:latest',
    );
    expect(client.resolveTag('myregistry.azurecr.io/autopod/test-app:latest')).toBe(
      'myregistry.azurecr.io/autopod/test-app:latest',
    );
  });
});

function tokenWithTenant(tenantId: string): string {
  const payload = Buffer.from(JSON.stringify({ tid: tenantId })).toString('base64url');
  return `header.${payload}.signature`;
}
