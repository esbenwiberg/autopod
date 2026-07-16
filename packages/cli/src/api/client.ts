import {
  AuthError,
  AutopodError,
  InvalidStateTransitionError,
  PodNotFoundError,
  ProfileNotFoundError,
  ValidationError,
} from '@autopod/shared';
import type {
  AgentEvent,
  CreatePodRequest,
  CreateScheduledJobRequest,
  CreateScheduledJobTemplateRequest,
  Pod,
  PodStatus,
  Profile,
  ProviderAccountProvider,
  ProviderCredentials,
  PublicProfile,
  PublicProviderAccount,
  ReadinessStatus,
  ScheduledJob,
  ScheduledJobTemplate,
  SpecContract,
  SpecFile,
  UpdateFromBaseResponse,
  UpdateScheduledJobRequest,
  UpdateScheduledJobTemplateRequest,
  ValidationResult,
  WatchedIssue,
} from '@autopod/shared';

export interface CreateSeriesRequest {
  seriesName: string;
  briefs: Array<{
    title: string;
    task: string;
    dependsOn: string[];
    contract?: SpecContract;
    /** Per-brief advisory list of files this pod expects to modify. */
    touches?: string[];
    /** Per-brief advisory list of files this pod should not modify. */
    doesNotTouch?: string[];
    /** Per-brief sidecar requests (e.g. `['dagger']`). */
    requireSidecars?: string[];
  }>;
  profile: string;
  startBranch?: string;
  baseBranch?: string;
  specFiles?: SpecFile[];
  specContextFiles?: SpecFile[];
  prMode?: 'single' | 'stacked' | 'none';
  /** Auto-approve each pod once it reaches `validated` — no human gate. */
  autoApprove?: boolean;
  /** Series purpose (from `purpose.md`) — PR "Why" + `## Purpose` in CLAUDE.md. */
  seriesDescription?: string;
  /** Series design (from `design.md`) — `## Design` in CLAUDE.md. */
  seriesDesign?: string;
}

export interface SeriesResponse {
  seriesId: string;
  seriesName: string;
  pods: Pod[];
  tokenUsageSummary: { inputTokens: number; outputTokens: number; costUsd: number };
  statusCounts: Record<string, number>;
}

export interface FirewallDenial {
  eventId: number;
  timestamp: string;
  sni: string;
  src: string;
}

export interface ApproveAllValidatedResponse {
  approved: string[];
  skipped?: Array<{
    podId: string;
    status: ReadinessStatus;
    reason: string;
  }>;
}
import { fetch } from 'undici';

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
  async createSession(req: CreatePodRequest): Promise<Pod> {
    return this.request<Pod>('POST', '/pods', req);
  }

  // Series
  async createSeries(req: CreateSeriesRequest): Promise<SeriesResponse> {
    return this.request<SeriesResponse>('POST', '/pods/series', req);
  }

  async getSeries(seriesId: string): Promise<SeriesResponse> {
    return this.request<SeriesResponse>('GET', `/pods/series/${seriesId}`);
  }

  async listSessions(filters?: { status?: string; profile?: string }): Promise<Pod[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.profile) params.set('profile', filters.profile);
    const qs = params.toString();
    return this.request<Pod[]>('GET', `/pods${qs ? `?${qs}` : ''}`);
  }

  async getSessionStats(filters?: {
    profile?: string;
  }): Promise<{ total: number; byStatus: Record<string, number> }> {
    const params = new URLSearchParams();
    if (filters?.profile) params.set('profile', filters.profile);
    const qs = params.toString();
    return this.request('GET', `/pods/stats${qs ? `?${qs}` : ''}`);
  }

  async getSession(id: string): Promise<Pod> {
    return this.request<Pod>('GET', `/pods/${id}`);
  }

  async sendMessage(id: string, message: string): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/message`, { message });
  }

  async getValidations(
    id: string,
  ): Promise<Array<{ id: string; attempt: number; result: ValidationResult; createdAt: string }>> {
    return this.request('GET', `/pods/${id}/validations`);
  }

  async triggerValidation(id: string): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/validate`);
  }

  async approveSession(id: string, opts?: { squash?: boolean; reason?: string }): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/approve`, opts);
  }

  async rejectSession(id: string, feedback: string): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/reject`, { feedback });
  }

  async pauseSession(id: string): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/pause`);
  }

  async nudgeSession(id: string, message: string): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/nudge`, { message });
  }

  async killSession(id: string): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/kill`);
  }

  async kickPod(
    id: string,
    reason?: string,
  ): Promise<{ ok: boolean; action: 'requeued' | 'failed' }> {
    return this.request<{ ok: boolean; action: 'requeued' | 'failed' }>(
      'POST',
      `/pods/${id}/kick`,
      reason ? { reason } : undefined,
    );
  }

  async updateFromBase(id: string): Promise<UpdateFromBaseResponse> {
    const path = `/pods/${id}/update-from-base`;
    const url = `${this.baseUrl}${path}`;
    let token: string;

    try {
      token = await this.getToken();
    } catch {
      throw new AuthError('Not authenticated. Try: ap login');
    }

    const doFetch = (t: string) =>
      fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${t}` } });

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await doFetch(token);
    } catch {
      throw new DaemonUnreachableError(this.baseUrl);
    }

    if (response.status === 401) {
      try {
        token = await this.getToken();
      } catch {
        throw new AuthError('Token refresh failed. Try: ap login');
      }
      try {
        response = await doFetch(token);
      } catch {
        throw new DaemonUnreachableError(this.baseUrl);
      }
    }

    // 409 has two meanings for this route: typed conflict response or INVALID_STATE error.
    if (response.status === 409) {
      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      if (body.action === 'conflict') {
        return body as UpdateFromBaseResponse;
      }
      const message = (body.message as string | undefined) ?? `HTTP 409 on ${path}`;
      const code = (body.code as string | undefined) ?? 'CONFLICT';
      throw new AutopodError(message, code, 409);
    }

    if (!response.ok) {
      await this.handleError(response, path);
    }

    return (await response.json()) as UpdateFromBaseResponse;
  }

  async completeSession(
    id: string,
    options?: {
      promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
      instructions?: string;
      skipAgent?: boolean;
    },
  ): Promise<{
    ok: boolean;
    pushError?: string;
    promotedTo?: 'pr' | 'branch' | 'artifact' | 'none';
  }> {
    return this.request<{
      ok: boolean;
      pushError?: string;
      promotedTo?: 'pr' | 'branch' | 'artifact' | 'none';
    }>('POST', `/pods/${id}/complete`, options ?? undefined);
  }

  async promoteSession(
    id: string,
    targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
    options?: { instructions?: string; skipAgent?: boolean },
  ): Promise<{ ok: boolean; promotedTo: string }> {
    return this.request<{ ok: boolean; promotedTo: string }>('POST', `/pods/${id}/promote`, {
      targetOutput,
      ...(options?.instructions ? { instructions: options.instructions } : {}),
      ...(options?.skipAgent ? { skipAgent: true } : {}),
    });
  }

  async injectCredential(id: string, service: 'github' | 'ado'): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/inject-credential`, { service });
  }

  async installCliTool(id: string, tool: 'gh' | 'az'): Promise<void> {
    await this.request<void>('POST', `/pods/${id}/install-cli`, { tool });
  }

  async deleteSession(id: string): Promise<void> {
    await this.request<void>('DELETE', `/pods/${id}`);
  }

  async createHistoryWorkspace(params: {
    profileName: string;
    since?: string;
    limit?: number;
    failuresOnly?: boolean;
  }): Promise<Pod> {
    return this.request<Pod>('POST', '/pods/history-workspace', params);
  }

  async getSessionLogs(id: string, buildLogs?: boolean): Promise<string> {
    if (!buildLogs) {
      const events = await this.getSessionEvents(id);
      return events
        .map(
          (event) => `${event.timestamp} ${event.type} ${'message' in event ? event.message : ''}`,
        )
        .join('\n');
    }
    const params = buildLogs ? '?build=true' : '';
    return this.request<string>('GET', `/pods/${id}/logs${params}`);
  }

  async getSessionEvents(id: string, limit?: number): Promise<AgentEvent[]> {
    const params = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
    return this.request<AgentEvent[]>('GET', `/pods/${id}/events${params}`);
  }

  async getFirewallDenials(id: string, limit?: number, until?: string): Promise<FirewallDenial[]> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (until) params.set('until', until);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<FirewallDenial[]>('GET', `/pods/${id}/firewall-denials${suffix}`);
  }

  async startPreview(id: string): Promise<{ previewUrl: string }> {
    return this.request<{ previewUrl: string }>('POST', `/pods/${id}/preview`);
  }

  async stopPreview(id: string): Promise<void> {
    await this.request<void>('DELETE', `/pods/${id}/preview`);
  }

  // Profiles
  async listProfiles(): Promise<PublicProfile[]> {
    return this.request<PublicProfile[]>('GET', '/profiles');
  }

  async getProfile(name: string): Promise<PublicProfile> {
    return this.request<PublicProfile>('GET', `/profiles/${name}`);
  }

  async getGitHubAuthStatus(): Promise<
    | { available: true; login: string | null; setup: string }
    | { available: false; reason: string; setup: string }
  > {
    return this.request('GET', '/profiles/github-auth/status');
  }

  async createProfile(profile: Partial<Profile>): Promise<PublicProfile> {
    return this.request<PublicProfile>('POST', '/profiles', profile);
  }

  async updateProfile(name: string, updates: Partial<Profile>): Promise<PublicProfile> {
    return this.request<PublicProfile>('PATCH', `/profiles/${name}`, updates);
  }

  async deleteProfile(name: string): Promise<void> {
    await this.request<void>('DELETE', `/profiles/${name}`);
  }

  async warmProfile(name: string, rebuild?: boolean): Promise<void> {
    await this.request<void>('POST', `/profiles/${name}/warm`, { rebuild });
  }

  async setProfileCredentials(
    name: string,
    credentials: { modelProvider: string; providerCredentials: unknown; defaultRuntime?: string },
  ): Promise<PublicProfile> {
    return this.request<PublicProfile>('PATCH', `/profiles/${name}`, credentials);
  }

  // Provider Accounts
  async listProviderAccounts(filters?: {
    provider?: ProviderAccountProvider;
  }): Promise<PublicProviderAccount[]> {
    const params = new URLSearchParams();
    if (filters?.provider) params.set('provider', filters.provider);
    const qs = params.toString();
    return this.request<PublicProviderAccount[]>('GET', `/provider-accounts${qs ? `?${qs}` : ''}`);
  }

  async getProviderAccount(id: string): Promise<PublicProviderAccount> {
    return this.request<PublicProviderAccount>('GET', `/provider-accounts/${id}`);
  }

  async createProviderAccount(account: {
    id?: string;
    name: string;
    provider: ProviderAccountProvider;
    credentials?: ProviderCredentials | null;
  }): Promise<PublicProviderAccount> {
    return this.request<PublicProviderAccount>('POST', '/provider-accounts', account);
  }

  async updateProviderAccount(
    id: string,
    changes: { name?: string; credentials?: ProviderCredentials | null },
  ): Promise<PublicProviderAccount> {
    return this.request<PublicProviderAccount>('PATCH', `/provider-accounts/${id}`, changes);
  }

  async deleteProviderAccount(id: string): Promise<void> {
    await this.request<void>('DELETE', `/provider-accounts/${id}`);
  }

  async linkProviderAccount(
    id: string,
    profileName: string,
    options?: { clearLegacyCredentials?: boolean },
  ): Promise<{ account: PublicProviderAccount; profile: PublicProfile }> {
    return this.request<{ account: PublicProviderAccount; profile: PublicProfile }>(
      'POST',
      `/provider-accounts/${id}/link-profile`,
      // Omit when unset so the daemon default (clear on link) applies.
      { profileName, clearLegacyCredentials: options?.clearLegacyCredentials },
    );
  }

  async setProfileProviderAccount(
    profileName: string,
    accountId: string | null,
    options?: { clearLegacyCredentials?: boolean },
  ): Promise<PublicProfile> {
    return this.request<PublicProfile>('POST', `/profiles/${profileName}/provider-account`, {
      accountId,
      // Omit when unset so the daemon picks the right default per direction
      // (clear on link, preserve on unlink).
      clearLegacyCredentials: options?.clearLegacyCredentials,
    });
  }

  async unlinkProfileProviderAccount(profileName: string): Promise<void> {
    await this.request<void>('DELETE', `/profiles/${profileName}/provider-account`);
  }

  async importProviderAccountFromProfile(request: {
    profileName: string;
    accountId?: string;
    accountName?: string;
    linkProfileNames?: string[];
    clearLegacyCredentials?: boolean;
  }): Promise<{
    account: PublicProviderAccount;
    linkedProfiles: PublicProfile[];
    legacyCredentialsCleared: boolean;
  }> {
    return this.request<{
      account: PublicProviderAccount;
      linkedProfiles: PublicProfile[];
      legacyCredentialsCleared: boolean;
    }>('POST', '/provider-accounts/import-from-profile', request);
  }

  // Scheduled Jobs
  async createScheduledJobTemplate(
    req: CreateScheduledJobTemplateRequest,
  ): Promise<ScheduledJobTemplate> {
    return this.request<ScheduledJobTemplate>('POST', '/scheduled-job-templates', req);
  }

  async listScheduledJobTemplates(): Promise<ScheduledJobTemplate[]> {
    return this.request<ScheduledJobTemplate[]>('GET', '/scheduled-job-templates');
  }

  async getScheduledJobTemplate(id: string): Promise<ScheduledJobTemplate> {
    return this.request<ScheduledJobTemplate>('GET', `/scheduled-job-templates/${id}`);
  }

  async updateScheduledJobTemplate(
    id: string,
    req: UpdateScheduledJobTemplateRequest,
  ): Promise<ScheduledJobTemplate> {
    return this.request<ScheduledJobTemplate>('PUT', `/scheduled-job-templates/${id}`, req);
  }

  async deleteScheduledJobTemplate(id: string): Promise<void> {
    await this.request<void>('DELETE', `/scheduled-job-templates/${id}`);
  }

  async createScheduledJob(req: CreateScheduledJobRequest): Promise<ScheduledJob> {
    return this.request<ScheduledJob>('POST', '/scheduled-jobs', req);
  }

  async listScheduledJobs(): Promise<ScheduledJob[]> {
    return this.request<ScheduledJob[]>('GET', '/scheduled-jobs');
  }

  async getScheduledJob(id: string): Promise<ScheduledJob> {
    return this.request<ScheduledJob>('GET', `/scheduled-jobs/${id}`);
  }

  async updateScheduledJob(id: string, req: UpdateScheduledJobRequest): Promise<ScheduledJob> {
    return this.request<ScheduledJob>('PUT', `/scheduled-jobs/${id}`, req);
  }

  async deleteScheduledJob(id: string): Promise<void> {
    await this.request<void>('DELETE', `/scheduled-jobs/${id}`);
  }

  async runScheduledJobCatchup(id: string): Promise<Pod> {
    return this.request<Pod>('POST', `/scheduled-jobs/${id}/catchup`);
  }

  async skipScheduledJobCatchup(id: string): Promise<void> {
    await this.request<void>('DELETE', `/scheduled-jobs/${id}/catchup`);
  }

  async triggerScheduledJob(id: string): Promise<Pod> {
    return this.request<Pod>('POST', `/scheduled-jobs/${id}/trigger`);
  }

  // Bulk
  async approveAllValidated(): Promise<ApproveAllValidatedResponse> {
    return this.request<ApproveAllValidatedResponse>('POST', '/pods/approve-all');
  }

  async killAllFailed(): Promise<{ killed: string[] }> {
    return this.request<{ killed: string[] }>('POST', '/pods/kill-failed');
  }

  async stopDaemon(): Promise<void> {
    await this.request<void>('POST', '/shutdown');
  }

  // Issue watcher
  async listWatchedIssues(filters?: {
    profile?: string;
    status?: string;
  }): Promise<WatchedIssue[]> {
    const params = new URLSearchParams();
    if (filters?.profile) params.set('profile', filters.profile);
    if (filters?.status) params.set('status', filters.status);
    const qs = params.toString();
    return this.request<WatchedIssue[]>('GET', `/issue-watcher${qs ? `?${qs}` : ''}`);
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
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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

  private async handleError(
    response: Awaited<ReturnType<typeof fetch>>,
    path: string,
  ): Promise<never> {
    let errorBody: { message?: string; code?: string; from?: PodStatus; to?: PodStatus } = {};
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
        if (path.includes('/pods/')) {
          const id = path.split('/pods/')[1]?.split('/')[0] ?? 'unknown';
          throw new PodNotFoundError(id);
        }
        throw new AutopodError(message, 'NOT_FOUND', 404);
      }
      case 409: {
        if (errorBody.from && errorBody.to) {
          const id = path.split('/pods/')[1]?.split('/')[0] ?? 'unknown';
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
