import type { SystemEvent } from '@autopod/shared';
import { readStoredToken } from './token.js';

/** Server-only envelope frames (not part of `SystemEvent`). */
type ControlFrame =
  | { type: 'subscribed_all' }
  | { type: 'replay_complete'; lastEventId: number }
  | { type: 'replay_truncated'; resumeFromEventId: number; reason: string }
  | { type: 'error'; message: string };

type WireFrame = (SystemEvent & { _eventId?: number }) | ControlFrame;

export interface WsClientCallbacks {
  /** Fired for every domain event. The store dispatcher lives here. */
  onEvent: (event: SystemEvent) => void;
  /** Fired when the server says replay overflowed — caller should do a full `/pods` refetch. */
  onReplayTruncated?: () => void;
  /** Fired when the open/closed state changes — drives connection UI badges. */
  onConnectionChange?: (connected: boolean) => void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function buildUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/events`;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function buildProtocols(token: string): string[] {
  return ['autopod', `autopod.bearer.${encodeBase64Url(token)}`];
}

export class WsClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId = 0;

  constructor(private readonly cb: WsClientCallbacks) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    const token = readStoredToken();
    if (!token) return;

    const socket = new WebSocket(buildUrl(), buildProtocols(token));
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retries = 0;
      this.cb.onConnectionChange?.(true);
      // Catch up first (no-op on first connect since lastEventId === 0),
      // then subscribe to the live stream.
      if (this.lastEventId > 0) {
        socket.send(JSON.stringify({ type: 'replay', lastEventId: this.lastEventId }));
      }
      socket.send(JSON.stringify({ type: 'subscribe_all' }));
    });

    socket.addEventListener('message', (msg: MessageEvent<string>) => {
      let frame: WireFrame;
      try {
        frame = JSON.parse(msg.data) as WireFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    socket.addEventListener('close', () => {
      this.cb.onConnectionChange?.(false);
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // The 'close' handler will follow; let it drive the reconnect.
    });
  }

  private handleFrame(frame: WireFrame): void {
    if (frame.type === 'replay_truncated') {
      this.cb.onReplayTruncated?.();
      return;
    }
    if (frame.type === 'subscribed_all' || frame.type === 'replay_complete') return;
    if (frame.type === 'error') return;

    const { _eventId, ...event } = frame as SystemEvent & { _eventId?: number };
    if (typeof _eventId === 'number') this.lastEventId = _eventId;
    this.cb.onEvent(event as SystemEvent);
  }

  private scheduleReconnect(): void {
    const idx = Math.min(this.retries, BACKOFF_MS.length - 1);
    const delay = BACKOFF_MS[idx] ?? 30000;
    this.retries += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
