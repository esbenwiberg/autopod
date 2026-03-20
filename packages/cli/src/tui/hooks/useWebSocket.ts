import type { SystemEvent } from '@autopod/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import WebSocket from 'ws';

export interface UseWebSocketOptions {
  url: string;
  token: string;
  onEvent: (event: SystemEvent) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export interface UseWebSocketReturn {
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  disconnect: () => void;
}

const MAX_BACKOFF = 30_000;
const BASE_BACKOFF = 1_000;
const MAX_JITTER = 1_000;

function getBackoff(attempt: number): number {
  const exponential = Math.min(BASE_BACKOFF * 2 ** attempt, MAX_BACKOFF);
  const jitter = Math.random() * MAX_JITTER;
  return exponential + jitter;
}

/**
 * WebSocket hook with exponential backoff reconnection.
 * Auth via ?token= query param.
 */
export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const { url, token, onEvent, onConnect, onDisconnect } = options;
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const intentionalCloseRef = useRef(false);

  // Use refs for callbacks to avoid re-triggering the effect
  const onEventRef = useRef(onEvent);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  onEventRef.current = onEvent;
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.removeAllListeners();
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(
    (attempt: number) => {
      if (!mountedRef.current) return;

      cleanup();

      const separator = url.includes('?') ? '&' : '?';
      const wsUrl = `${url}${separator}token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.on('open', () => {
        if (!mountedRef.current) return;
        setConnected(true);
        setReconnecting(false);
        setReconnectAttempt(0);
        onConnectRef.current();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        if (!mountedRef.current) return;
        try {
          const event = JSON.parse(data.toString()) as SystemEvent;
          onEventRef.current(event);
        } catch {
          // Silently ignore malformed messages
        }
      });

      ws.on('close', () => {
        if (!mountedRef.current || intentionalCloseRef.current) return;
        setConnected(false);
        onDisconnectRef.current();

        const nextAttempt = attempt + 1;
        setReconnecting(true);
        setReconnectAttempt(nextAttempt);

        const delay = getBackoff(attempt);
        reconnectTimerRef.current = setTimeout(() => {
          connect(nextAttempt);
        }, delay);
      });

      ws.on('error', () => {
        // The 'close' handler will fire after this and handle reconnection
      });
    },
    [url, token, cleanup],
  );

  useEffect(() => {
    mountedRef.current = true;
    intentionalCloseRef.current = false;
    connect(0);

    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      cleanup();
    };
  }, [connect, cleanup]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    cleanup();
    setConnected(false);
    setReconnecting(false);
  }, [cleanup]);

  return { connected, reconnecting, reconnectAttempt, disconnect };
}
