import { useCallback, useEffect, useRef } from 'react';

type MessageHandler = (data: MessageEvent) => void;

export function useWebSocket(url: string | null, onMessage: MessageHandler): void {
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!url) return;

    let ws: WebSocket;
    let closed = false;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (ev) => handlerRef.current(ev);
      ws.onclose = (ev) => {
        if (!closed && ev.code !== 1000) {
          // Reconnect after 3s on unexpected closes
          setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      ws?.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [url]);
}

/** Returns a stable send function for an open WebSocket. */
export function useWebSocketSend(url: string | null): (data: string | ArrayBufferLike) => void {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!url) return;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    return () => {
      ws.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [url]);

  return useCallback((data) => {
    wsRef.current?.send(data);
  }, []);
}
