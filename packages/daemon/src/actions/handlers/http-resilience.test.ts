import { type RequestListener, createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, readSafeJson } from './handler.js';

const LIMIT = 2 * 1024 * 1024;
const cleanups: Array<() => Promise<void>> = [];

async function serve(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

describe('action HTTP transport resource bounds', () => {
  it.each(['delayed headers', 'stalled body', 'slow chunks'])(
    'enforces the complete deadline and closes the socket: %s',
    async (mode) => {
      let socketClosed = false;
      const url = await serve((_req, res) => {
        if (mode !== 'delayed headers') {
          res.writeHead(200);
          res.write('[');
        }
        const interval = mode === 'slow chunks' ? setInterval(() => res.write(' '), 10) : undefined;
        const safetyCutoff = setTimeout(() => res.end(']'), 1_200);
        res.on('close', () => {
          socketClosed = true;
          clearTimeout(safetyCutoff);
          clearInterval(interval);
        });
      });
      const started = performance.now();
      await expect(
        fetchWithTimeout(url, { timeout: 60 }).then((response) => response.text()),
      ).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1_000);
      await vi.waitFor(() => expect(socketClosed).toBe(true));
    },
  );

  it('preserves caller cancellation during body consumption', async () => {
    const controller = new AbortController();
    let closed = false;
    const url = await serve((_req, res) => {
      res.writeHead(200);
      res.write('[');
      const cancel = setTimeout(() => controller.abort(), 30);
      const safetyCutoff = setTimeout(() => res.end(']'), 1_200);
      res.on('close', () => {
        closed = true;
        clearTimeout(cancel);
        clearTimeout(safetyCutoff);
      });
    });
    await expect(
      fetchWithTimeout(url, { timeout: 2_000, signal: controller.signal }).then((r) => r.text()),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it.each([200, 503])('bounds chunked response bytes for status %s', async (status) => {
    const url = await serve((_req, res) => {
      res.writeHead(status);
      res.write('x'.repeat(LIMIT));
      res.end('x');
    });
    await expect(fetchWithTimeout(url, {}).then((r) => r.text())).rejects.toThrow(/too large/i);
  });

  it('bounds decompressed response bytes', async () => {
    const body = gzipSync('x'.repeat(LIMIT + 1));
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length });
      res.end(body);
    });
    await expect(fetchWithTimeout(url, {}).then((r) => r.text())).rejects.toThrow(/too large/i);
  });

  it('counts UTF-8 bytes rather than JavaScript characters', async () => {
    const response = new Response(JSON.stringify('é'.repeat(LIMIT / 2)));
    await expect(readSafeJson(response)).rejects.toThrow(/too large/i);
  });

  it('stops reading and cancels an oversized stream before its end', async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
          if (pulls === 100) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readSafeJson(response)).rejects.toThrow(/too large/i);
    expect(pulls).toBeLessThan(40);
    expect(cancelled).toBe(true);
  });

  it('retains valid JSON and empty 204 response semantics', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/empty') {
        res.writeHead(204);
        res.end();
      } else {
        res.end('{"ok":true}');
      }
    });
    expect(await readSafeJson(await fetchWithTimeout(url, {}))).toEqual({ ok: true });
    const empty = await fetchWithTimeout(`${url}/empty`, {});
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
  });
});
