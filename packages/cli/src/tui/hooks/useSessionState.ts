import { useState, useCallback, useEffect, useRef } from 'react';
import type { Session, SessionStatus, SystemEvent } from '@autopod/shared';

export interface UseSessionStateOptions {
  daemonUrl: string;
  token: string;
}

export interface UseSessionStateReturn {
  sessions: Session[];
  selectedSession: Session | null;
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  handleEvent: (event: SystemEvent) => void;
}

const ACTIVE_STATUSES: SessionStatus[] = ['running', 'awaiting_input', 'validating', 'provisioning', 'queued'];

function isActive(status: SessionStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const aActive = isActive(a.status);
    const bActive = isActive(b.status);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Session state management: fetches from REST, updates via WebSocket events.
 */
export function useSessionState(options: UseSessionStateOptions): UseSessionStateReturn {
  const { daemonUrl, token } = options;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const baseUrl = daemonUrl.replace(/\/$/, '');

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchJson<Session[]>(`${baseUrl}/sessions`, token);
      setSessions(sortSessions(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      setLoading(false);
    }
  }, [baseUrl, token]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch full session details when selection changes (debounced)
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!selectedSessionId) {
      setSelectedSession(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const session = await fetchJson<Session>(
            `${baseUrl}/sessions/${selectedSessionId}`,
            token,
          );
          setSelectedSession(session);
        } catch {
          // Fall back to the summary from the list
          const fromList = sessions.find((s) => s.id === selectedSessionId) ?? null;
          setSelectedSession(fromList);
        }
      })();
    }, 200);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [selectedSessionId, baseUrl, token, sessions]);

  const handleEvent = useCallback((event: SystemEvent) => {
    switch (event.type) {
      case 'session.created': {
        setSessions((prev) =>
          sortSessions([
            ...prev,
            {
              id: event.session.id,
              profileName: event.session.profileName,
              task: event.session.task,
              status: event.session.status,
              model: event.session.model,
              runtime: event.session.runtime,
              executionTarget: 'local',
              branch: '',
              containerId: null,
              worktreePath: null,
              validationAttempts: 0,
              maxValidationAttempts: 3,
              lastValidationResult: null,
              pendingEscalation: null,
              escalationCount: 0,
              skipValidation: false,
              createdAt: event.timestamp,
              startedAt: null,
              completedAt: null,
              updatedAt: event.timestamp,
              userId: '',
              filesChanged: event.session.filesChanged,
              linesAdded: 0,
              linesRemoved: 0,
              previewUrl: null,
              prUrl: null,
              plan: null,
              progress: null,
              claudeSessionId: null,
            },
          ]),
        );
        break;
      }
      case 'session.status_changed': {
        setSessions((prev) =>
          sortSessions(
            prev.map((s) =>
              s.id === event.sessionId ? { ...s, status: event.newStatus, updatedAt: event.timestamp } : s,
            ),
          ),
        );
        break;
      }
      case 'session.completed': {
        setSessions((prev) =>
          sortSessions(
            prev.map((s) =>
              s.id === event.sessionId
                ? { ...s, status: event.finalStatus, completedAt: event.timestamp, updatedAt: event.timestamp }
                : s,
            ),
          ),
        );
        break;
      }
      default:
        // Other events don't affect the session list
        break;
    }
  }, []);

  return {
    sessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    loading,
    error,
    refresh,
    handleEvent,
  };
}
