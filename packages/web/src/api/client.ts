import type { CreateSessionRequest, Session, SessionStatus } from '@autopod/shared';

export interface ClientConfig {
  baseUrl: string;
  getToken: () => Promise<string>;
}

export interface DaemonAppConfig {
  devMode: boolean;
  clientId: string | null;
  tenantId: string | null;
}

export class AutopodWebClient {
  private baseUrl: string;
  private getToken: () => Promise<string>;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.getToken = config.getToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;

    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/plain')) return (await res.text()) as T;
    return (await res.json()) as T;
  }

  listSessions(filters?: { status?: SessionStatus; profileName?: string }): Promise<Session[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.profileName) params.set('profileName', filters.profileName);
    const qs = params.toString();
    return this.request<Session[]>('GET', `/sessions${qs ? `?${qs}` : ''}`);
  }

  getSession(id: string): Promise<Session> {
    return this.request<Session>('GET', `/sessions/${id}`);
  }

  createSession(req: CreateSessionRequest): Promise<Session> {
    return this.request<Session>('POST', '/sessions', req);
  }

  approveSession(id: string): Promise<void> {
    return this.request<void>('POST', `/sessions/${id}/approve`);
  }

  rejectSession(id: string, feedback: string): Promise<void> {
    return this.request<void>('POST', `/sessions/${id}/reject`, { feedback });
  }

  killSession(id: string): Promise<void> {
    return this.request<void>('POST', `/sessions/${id}/kill`);
  }

  pauseSession(id: string): Promise<void> {
    return this.request<void>('POST', `/sessions/${id}/pause`);
  }

  sendMessage(id: string, message: string): Promise<void> {
    return this.request<void>('POST', `/sessions/${id}/message`, { message });
  }

  nudgeSession(id: string, message: string): Promise<void> {
    return this.request<void>('POST', `/sessions/${id}/nudge`, { message });
  }

  deleteSession(id: string): Promise<void> {
    return this.request<void>('DELETE', `/sessions/${id}`);
  }

  getSessionLogs(id: string): Promise<string> {
    return this.request<string>('GET', `/sessions/${id}/logs`);
  }

  /** Fetch the daemon's public app config (no auth required). */
  static async fetchAppConfig(baseUrl: string): Promise<DaemonAppConfig> {
    const url = baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${url}/config`);
    if (!res.ok) throw new Error(`Failed to fetch daemon config: ${res.status}`);
    return res.json() as Promise<DaemonAppConfig>;
  }

  /** WebSocket URL for the event stream. */
  async eventsWsUrl(): Promise<string> {
    const token = await this.getToken();
    return `${this.baseUrl.replace(/^http/, 'ws')}/events?token=${encodeURIComponent(token)}`;
  }

  /** WebSocket URL for a workspace pod terminal. */
  async terminalWsUrl(sessionId: string, cols = 120, rows = 40): Promise<string> {
    const token = await this.getToken();
    const base = this.baseUrl.replace(/^http/, 'ws');
    return `${base}/sessions/${sessionId}/terminal?token=${encodeURIComponent(token)}&cols=${cols}&rows=${rows}`;
  }
}
