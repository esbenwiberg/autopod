import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Azure SDK modules — must be before import
const mockGetToken = vi.fn().mockResolvedValue({ token: 'mock-token-xyz' });
const mockGetManifestProperties = vi.fn().mockResolvedValue({ digest: 'sha256:abc' });

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken = mockGetToken;
  },
}));

vi.mock('@azure/container-registry', () => ({
  ContainerRegistryClient: class {
    getArtifact = vi.fn().mockReturnValue({
      getManifestProperties: mockGetManifestProperties,
    });
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
    mockGetToken.mockResolvedValue({ token: 'mock-token-xyz' });
    mockGetManifestProperties.mockResolvedValue({ digest: 'sha256:abc' });
  });

  it('pushes image to ACR', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    const digest = await client.push('autopod/test-app:latest');

    expect(digest).toBe('sha256:deadbeef');
    expect(mockDocker.checkAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        username: '00000000-0000-0000-0000-000000000000',
        password: 'mock-token-xyz',
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
        authconfig: { serveraddress: 'myregistry.azurecr.io' },
      }),
    );
  });

  it('checks if image exists in ACR', async () => {
    const mockDocker = createMockDocker();
    const client = new AcrClient({ registryUrl: 'myregistry.azurecr.io' }, mockDocker);

    const exists = await client.exists('autopod/test-app:latest');
    expect(exists).toBe(true);
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
});
