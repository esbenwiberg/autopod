import { SessionNotFoundError } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { resolveSessionId } from './id-resolver.js';

describe('resolveSessionId', () => {
  const mockClient = {
    listSessions: vi.fn(),
  } as unknown as AutopodClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full ID when 8+ characters', async () => {
    const result = await resolveSessionId(mockClient, 'abcd1234');
    expect(result).toBe('abcd1234');
    expect(mockClient.listSessions).not.toHaveBeenCalled();
  });

  it('rejects IDs shorter than 3 characters', async () => {
    await expect(resolveSessionId(mockClient, 'ab')).rejects.toThrow('at least 3 characters');
  });

  it('resolves partial ID to full ID', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'abcd1234' },
      { id: 'efgh5678' },
    ]);

    const result = await resolveSessionId(mockClient, 'abc');
    expect(result).toBe('abcd1234');
  });

  it('throws SessionNotFoundError when no match', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'efgh5678' },
    ]);

    await expect(resolveSessionId(mockClient, 'xyz')).rejects.toThrow(SessionNotFoundError);
  });

  it('throws on ambiguous matches', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'abcd1234' },
      { id: 'abce5678' },
    ]);

    await expect(resolveSessionId(mockClient, 'abc')).rejects.toThrow('Ambiguous');
  });
});
