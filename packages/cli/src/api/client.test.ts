import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopodClient, DaemonUnreachableError } from './client.js';
import {
  AuthError,
  SessionNotFoundError,
  ProfileNotFoundError,
  InvalidStateTransitionError,
  ValidationError,
  AutopodError,
} from '@autopod/shared';

// Mock undici's fetch
const mockFetch = vi.fn();
vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

function jsonResponse(data: unknown, status = 200): object {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name === 'content-type' ? 'application/json' : null),
    },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function errorResponse(status: number, body: object = {}): object {
  return {
    ok: false,
    status,
    headers: {
      get: () => 'application/json',
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('AutopodClient', () => {
  let client: AutopodClient;
  const getToken = vi.fn().mockResolvedValue('test-token');

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AutopodClient({ baseUrl: 'http://localhost:3100', getToken });
  });

  describe('createSession', () => {
    it('sends POST to /sessions', async () => {
      const session = { id: 'abc12345', profileName: 'test', task: 'do stuff', status: 'queued' };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.createSession({ profileName: 'test', task: 'do stuff' });

      expect(result).toEqual(session);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/sessions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });
  });

  describe('listSessions', () => {
    it('sends GET to /sessions with query params', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.listSessions({ status: 'running', profile: 'myproj' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/sessions?status=running&profile=myproj',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('sends GET to /sessions without query params', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.listSessions();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/sessions',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('getSession', () => {
    it('fetches a single session', async () => {
      const session = { id: 'abc12345', status: 'running' };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.getSession('abc12345');
      expect(result).toEqual(session);
    });
  });

  describe('sendMessage', () => {
    it('sends POST with message body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(undefined, 204));

      await client.sendMessage('abc12345', 'hello');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/sessions/abc12345/message',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'hello' }),
        }),
      );
    });
  });

  describe('approveSession', () => {
    it('sends POST to approve endpoint', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(undefined, 204));

      await client.approveSession('abc12345', { squash: true });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/sessions/abc12345/approve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ squash: true }),
        }),
      );
    });
  });

  describe('profiles', () => {
    it('lists profiles', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([{ name: 'test' }]));
      const result = await client.listProfiles();
      expect(result).toEqual([{ name: 'test' }]);
    });

    it('creates a profile', async () => {
      const profile = { name: 'new-proj' };
      mockFetch.mockResolvedValueOnce(jsonResponse(profile));
      const result = await client.createProfile(profile);
      expect(result).toEqual(profile);
    });

    it('deletes a profile', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(undefined, 204));
      await client.deleteProfile('old-proj');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/profiles/old-proj',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('bulk operations', () => {
    it('approves all validated', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ approved: ['a', 'b'] }));
      const result = await client.approveAllValidated();
      expect(result.approved).toEqual(['a', 'b']);
    });

    it('kills all failed', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ killed: ['c'] }));
      const result = await client.killAllFailed();
      expect(result.killed).toEqual(['c']);
    });
  });

  describe('health check', () => {
    it('returns health info', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok', version: '1.0.0' }));
      const result = await client.checkHealth();
      expect(result.version).toBe('1.0.0');
    });
  });

  describe('error mapping', () => {
    it('maps 401 to AuthError', async () => {
      mockFetch.mockResolvedValue(errorResponse(401, { message: 'unauthorized' }));
      await expect(client.listSessions()).rejects.toThrow(AuthError);
    });

    it('maps 404 on sessions to SessionNotFoundError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, { message: 'not found' }));
      await expect(client.getSession('abc')).rejects.toThrow(SessionNotFoundError);
    });

    it('maps 404 on profiles to ProfileNotFoundError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, { message: 'not found' }));
      await expect(client.getProfile('nope')).rejects.toThrow(ProfileNotFoundError);
    });

    it('maps 409 with from/to to InvalidStateTransitionError', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(409, { message: 'bad transition', from: 'queued', to: 'complete' }),
      );
      await expect(client.approveSession('abc')).rejects.toThrow(InvalidStateTransitionError);
    });

    it('maps 422 to ValidationError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(422, { message: 'bad input' }));
      await expect(client.createSession({ profileName: '', task: '' })).rejects.toThrow(ValidationError);
    });

    it('maps 500 to AutopodError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, { message: 'boom', code: 'INTERNAL' }));
      await expect(client.listSessions()).rejects.toThrow(AutopodError);
    });

    it('maps network error to DaemonUnreachableError', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(client.checkHealth()).rejects.toThrow(DaemonUnreachableError);
    });
  });

  describe('token refresh on 401', () => {
    it('retries once on 401 with fresh token', async () => {
      const session = { id: 'abc', status: 'running' };
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, { message: 'expired' }))
        .mockResolvedValueOnce(jsonResponse(session));

      getToken.mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token');

      const result = await client.getSession('abc');
      expect(result).toEqual(session);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
