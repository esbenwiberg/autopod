import { fetch } from 'undici';
import {
  AutopodError,
  AuthError,
  SessionNotFoundError,
  ProfileNotFoundError,
  InvalidStateTransitionError,
  ValidationError,
} from '@autopod/shared';
import type {
  Session,
  CreateSessionRequest,
  Profile,
  SessionStatus,
} from '@autopod/shared';

export class DaemonUnreachableError extends AutopodError {
  constructor(url: string) {
    super(`Cannot reach daemon at ${url}`, 'DAEMON_UNREACHABLE', 503);
    this.name = 'DaemonUnreachableError';
  }
}

interface ClientConfig {
  baseUrl: string;
  getToken: () => Promise<string>;
}

export class AutopodClient {
  private baseUrl: string;
  private getToken: () => Promise<string>;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.getToken = config.getToken;
  }

  // Sessions
  async createSession(req: CreateSessionRequest): Promise<Session> {
    return this.request<Session>('POST', '/sessions', req);
  }

  async listSessions(filters?: { status?: string; profile?: string }): Promise<Session[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.profile) params.set('profile', filters.profile);
    const qs = params.toString();
    return this.request<Session[]>('GET', `/sessions${qs ? `?${qs}` : ''}`);
  }

  async getSession(id: string): Promise<Session> {
    return this.request<Session>('GET', `/sessions/${id}`);
  }

  async sendMessage(id: string, message: string): Promise<void> {
    await this.request<void>('POST', `/sessions/${id}/message`, { message });
  }

  async triggerValidation(id: string): Promise<void> {
    await this.request<void>('POST', `/sessions/${id}/validate`);
  }

  async approveSession(id: string, opts?: { squash?: boolean }): Promise<void> {
    await this.request<void>('POST', `/sessions/${id}/approve`, opts);
  }

  async rejectSession(id: string, feedback: string): Promise<void> {
    await this.request<void>('POST', `/sessions/${id}/reject`, { feedback });
  }

  async pauseSession(id: string): Promise<void> {
    await this.request<void>('POST', `/sessions/${id}/pause`);
  }

  async nudgeSession(id: string, message: string): Promise<void> {
    await this.request<void>('POST', `/sessions/${id}/nudge`, { message });
  }

  async killSession(id: string): Promise<void> {
    await this.request<void>('POST', `/sessions/${id}/kill`);
  }

  async getSessionLogs(id: string, buildLogs?: boolean): Promise<string> {
    const params = buildLogs ? '?build=true' : '';
    return this.request<string>('GET', `/sessions/${id}/logs${params}`);
  }

  // Profiles
  async listProfiles(): Promise<Profile[]> {
    return this.request<Profile[]>('GET', '/profiles');
  }

  async getProfile(name: string): Promise<Profile> {
    return this.request<Profile>('GET', `/profiles/${name}`);
  }

  async createProfile(profile: Partial<Profile>): Promise<Profile> {
    return this.request<Profile>('POST', '/profiles', profile);
  }

  async updateProfile(name: string, updates: Partial<Profile>): Promise<Profile> {
    return this.request<Profile>('PATCH', `/profiles/${name}`, updates);
  }

  async deleteProfile(name: string): Promise<void> {
    await this.request<void>('DELETE', `/profiles/${name}`);
  }

  async warmProfile(name: string, rebuild?: boolean): Promise<void> {
    await this.request<void>('POST', `/profiles/${name}/warm`, { rebuild });
  }

  // Bulk
  async approveAllValidated(): Promise<{ approved: string[] }> {
    return this.request<{ approved: string[] }>('POST', '/sessions/approve-all');
  }

  async killAllFailed(): Promise<{ killed: string[] }> {
    return this.request<{ killed: string[] }>('POST', '/sessions/kill-failed');
  }

  // Health
  async checkHealth(): Promise<{ status: string; version: string }> {
    return this.request<{ status: string; version: string }>('GET', '/health');
  }

  // WebSocket helpers
  async fetchToken(): Promise<string> {
    return this.getToken();
  }

  getWebSocketUrl(path: string): string {
    return this.baseUrl.replace(/^http/, 'ws') + path;
  }

  // Internal
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let token: string;

    try {
      token = await this.getToken();
    } catch {
      throw new AuthError('Not authenticated. Try: ap login');
    }

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new DaemonUnreachableError(this.baseUrl);
    }

    if (response.status === 401) {
      // Single retry with fresh token
      try {
        token = await this.getToken();
        response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw new AuthError('Token refresh failed. Try: ap login');
      }
    }

    if (!response.ok) {
      await this.handleError(response, path);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/plain')) {
      return (await response.text()) as T;
    }

    return (await response.json()) as T;
  }

  private async handleError(response: Awaited<ReturnType<typeof fetch>>, path: string): Promise<never> {
    let errorBody: { message?: string; code?: string; from?: SessionStatus; to?: SessionStatus } = {};
    try {
      errorBody = (await response.json()) as typeof errorBody;
    } catch {
      // response body wasn't JSON
    }

    const message = errorBody.message ?? `HTTP ${response.status} on ${path}`;

    switch (response.status) {
      case 401:
        throw new AuthError(message);
      case 403:
        throw new AutopodError(message, 'FORBIDDEN', 403);
      case 404: {
        if (path.includes('/profiles/')) {
          const name = path.split('/profiles/')[1]?.split('/')[0] ?? 'unknown';
          throw new ProfileNotFoundError(name);
        }
        if (path.includes('/sessions/')) {
          const id = path.split('/sessions/')[1]?.split('/')[0] ?? 'unknown';
          throw new SessionNotFoundError(id);
        }
        throw new AutopodError(message, 'NOT_FOUND', 404);
      }
      case 409: {
        if (errorBody.from && errorBody.to) {
          const id = path.split('/sessions/')[1]?.split('/')[0] ?? 'unknown';
          throw new InvalidStateTransitionError(id, errorBody.from, errorBody.to);
        }
        throw new AutopodError(message, 'CONFLICT', 409);
      }
      case 422:
        throw new ValidationError(message);
      default:
        throw new AutopodError(message, errorBody.code ?? 'UNKNOWN', response.status);
    }
  }
}
