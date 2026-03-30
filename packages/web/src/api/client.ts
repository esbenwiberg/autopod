import type { CreateSessionRequest, Session, SessionStatus } from '@autopod/shared';

export interface DaemonConfig {
  baseUrl: string;
  token: string;
}

export class AutopodWebClient {
  private baseUrl: string;
  private token: string;

  constructor(config: DaemonConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
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

  getReportUrl(id: string): string {
    return `${this.baseUrl}/sessions/${id}/report`;
  }

  /** Build a WebSocket URL for the event stream. */
  eventsWsUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/events?token=${encodeURIComponent(this.token)}`;
  }

  /** Build a WebSocket URL for the terminal of a workspace pod. */
  terminalWsUrl(sessionId: string, cols = 120, rows = 40): string {
    const base = this.baseUrl.replace(/^http/, 'ws');
    return `${base}/sessions/${sessionId}/terminal?token=${encodeURIComponent(this.token)}&cols=${cols}&rows=${rows}`;
  }
}
