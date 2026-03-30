import type { Session } from '@autopod/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutopodWebClient } from '../api/client.js';

export function useSessions(client: AutopodWebClient | null): {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(() => {
    if (!client) return;
    setLoading(true);
    client
      .listSessions()
      .then((s) => {
        setSessions(s);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [client]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates via WebSocket
  useEffect(() => {
    if (!client) return;

    let closed = false;

    const connect = () => {
      if (closed) return;
      client
        .eventsWsUrl()
        .then((url) => {
          if (closed) return;
          const ws = new WebSocket(url);
          wsRef.current = ws;

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'subscribe_all' }));
          };

          ws.onmessage = (ev) => {
            try {
              const event = JSON.parse(ev.data as string) as { type: string };
              if (
                event.type === 'session.created' ||
                event.type === 'session.status_changed' ||
                event.type === 'session.completed'
              ) {
                client
                  .listSessions()
                  .then(setSessions)
                  .catch(() => {});
              }
            } catch {
              // Ignore malformed events
            }
          };

          ws.onclose = (ev) => {
            if (!closed && ev.code !== 1000) {
              setTimeout(connect, 3000);
            }
          };
        })
        .catch(() => {
          if (!closed) setTimeout(connect, 5000);
        });
    };

    connect();

    return () => {
      closed = true;
      wsRef.current?.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [client]);

  return { sessions, loading, error, refresh };
}
