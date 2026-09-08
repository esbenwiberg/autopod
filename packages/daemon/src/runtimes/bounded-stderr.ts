import type { Readable } from 'node:stream';

const MAX_STDERR_BYTES = 16 * 1024;
const STDERR_DRAIN_MS = 1000;

/** Bounded diagnostic tail. It is never authoritative process-exit evidence. */
export function captureBoundedStderr(stream: Readable) {
  let tail: Buffer = Buffer.alloc(0);
  let truncated = false;
  let complete = stream.readableEnded;
  let settled = complete || stream.destroyed;
  let resolveDrain: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  if (settled) resolveDrain();
  const settle = (readComplete: boolean) => {
    if (settled) return;
    settled = true;
    complete = readComplete;
    resolveDrain();
  };
  const onData = (chunk: Buffer | string) => {
    if (settled) return;
    // Slice before allocation: even one oversized chunk cannot grow our retained tail.
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk.slice(-MAX_STDERR_BYTES))
        : chunk.subarray(-MAX_STDERR_BYTES);
    truncated ||= chunk.length > MAX_STDERR_BYTES || tail.length + bytes.length > MAX_STDERR_BYTES;
    tail = Buffer.from(
      Buffer.concat([tail, bytes.subarray(-MAX_STDERR_BYTES)]).subarray(-MAX_STDERR_BYTES),
    );
  };
  const onEnd = () => settle(true);
  const onClose = () => settle(stream.readableEnded);
  const onError = () => settle(false);
  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onClose);
  stream.on('error', onError);
  const dispose = () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
    stream.off('close', onClose);
    tail = Buffer.alloc(0);
    // Keep the bounded error guard on the owned stream: late transport errors
    // after abandoned execution must not become unhandled daemon exceptions.
  };
  return {
    dispose,
    async finish() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!settled)
          await Promise.race([
            drained,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, STDERR_DRAIN_MS);
              timer.unref?.();
            }),
          ]);
        return { text: tail.toString('utf8'), complete: complete && !truncated, truncated };
      } finally {
        if (timer) clearTimeout(timer);
        dispose();
      }
    },
  };
}
