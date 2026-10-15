import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { followLogs } from './log-follow.js';

class FollowPeer extends EventEmitter {
  send = vi.fn((_data: string, _callback: (error?: Error) => void) => {});
  terminate = vi.fn();
}

function setup(onOpen = vi.fn()) {
  const socket = new FollowPeer();
  const signals = new EventEmitter();
  const onEvent = vi.fn();
  const result = followLogs(socket, 'fixture-pod', { onOpen, onEvent }, signals);
  // Observe rejections immediately even in races where close is delayed.
  const outcome = result.then(
    () => null,
    (error: unknown) => error,
  );
  return { socket, signals, onOpen, onEvent, outcome };
}

describe('log follow lifecycle', () => {
  it('preserves a failure when SIGINT arrives before close, and terminates only once', async () => {
    const { socket, signals, outcome } = setup();
    socket.emit('error', new Error('first failure'));
    signals.emit('SIGINT');
    socket.emit('error', new Error('later failure'));
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount('error')).toBe(1);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.emit('close', 1006);
    expect(await outcome).toEqual(new Error('WebSocket error: first failure'));
  });

  it('keeps SIGINT successful through connecting termination error and close', async () => {
    const { socket, signals, outcome, onOpen, onEvent } = setup();
    signals.emit('SIGINT');
    socket.emit('error', new Error('WebSocket was closed before the connection was established'));
    socket.emit('open');
    socket.emit('message', Buffer.from('{"type":"error"}'));
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit('close', 1006);
    expect(await outcome).toBeNull();
  });

  it('removes only owned socket and signal listeners after settlement', async () => {
    const socket = new FollowPeer();
    const signals = new EventEmitter();
    const foreign = vi.fn();
    for (const event of ['open', 'message', 'error', 'close']) socket.on(event, foreign);
    signals.on('SIGINT', foreign);
    const result = followLogs(
      socket,
      'fixture-pod',
      { onOpen: vi.fn(), onEvent: vi.fn() },
      signals,
    );
    signals.emit('SIGINT');
    socket.emit('close', 1006);
    await result;
    for (const event of ['open', 'message', 'error', 'close']) {
      expect(socket.listeners(event)).toEqual([foreign]);
    }
    expect(signals.listeners('SIGINT')).toEqual([foreign]);
    signals.emit('SIGINT');
    socket.emit('close', 1006);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['send throws', 'send callback', 'open callback'])(
    'settles %s failures on close',
    async (mode) => {
      const failure = new Error('subscription setup failed');
      const { socket, outcome, onOpen } = setup();
      if (mode === 'send throws')
        socket.send.mockImplementation(() => {
          throw failure;
        });
      if (mode === 'send callback')
        socket.send.mockImplementation((_data, callback) => callback(failure));
      if (mode === 'open callback')
        onOpen.mockImplementation(() => {
          throw failure;
        });
      socket.emit('open');
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      socket.emit('close', 1006);
      expect(await outcome).toBeInstanceOf(Error);
      expect(((await outcome) as Error).message).toContain(failure.message);
    },
  );

  it('ignores malformed frames and acknowledgements without losing a later valid event', async () => {
    const { socket, signals, outcome, onEvent } = setup();
    for (const frame of [
      '{',
      'null',
      '{"type":"subscribed"}',
      '{"type":"unsubscribed"}',
      '{"type":"subscribed_all"}',
    ]) {
      socket.emit('message', Buffer.from(frame));
    }
    socket.emit('message', Buffer.from('{"type":"pod.completed"}'));
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'pod.completed' });
    expect(socket.terminate).not.toHaveBeenCalled();
    signals.emit('SIGINT');
    socket.emit('close', 1006);
    expect(await outcome).toBeNull();
  });
});
