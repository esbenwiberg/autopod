import { PodNotFoundError } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { resolvePodId } from './id-resolver.js';

describe('resolvePodId', () => {
  const mockClient = {
    listSessions: vi.fn(),
  } as unknown as AutopodClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full ID when 8+ characters', async () => {
    const result = await resolvePodId(mockClient, 'abcd1234');
    expect(result).toBe('abcd1234');
    expect(mockClient.listSessions).not.toHaveBeenCalled();
  });

  it('rejects IDs shorter than 3 characters', async () => {
    await expect(resolvePodId(mockClient, 'ab')).rejects.toThrow('at least 3 characters');
  });

  it('resolves partial ID to full ID', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'abcd1234' },
      { id: 'efgh5678' },
    ]);

    const result = await resolvePodId(mockClient, 'abc');
    expect(result).toBe('abcd1234');
  });

  it('throws PodNotFoundError when no match', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'efgh5678' },
    ]);

    await expect(resolvePodId(mockClient, 'xyz')).rejects.toThrow(PodNotFoundError);
  });

  it('throws on ambiguous matches', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'abcd1234' },
      { id: 'abce5678' },
    ]);

    await expect(resolvePodId(mockClient, 'abc')).rejects.toThrow('Ambiguous');
  });
});
