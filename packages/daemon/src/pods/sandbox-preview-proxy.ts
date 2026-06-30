import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';

const DEFAULT_CONTAINER_PORT = 3000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SANDBOX_PREVIEW_FETCH_SCRIPT = `
const http = require('node:http');
const method = process.env.AUTOPOD_PREVIEW_METHOD || 'GET';
const requestPath = process.env.AUTOPOD_PREVIEW_PATH || '/';
const port = Number(process.env.AUTOPOD_PREVIEW_PORT || '3000');
const timeoutMs = Number(process.env.AUTOPOD_PREVIEW_TIMEOUT_MS || '30000');
const rawHeaders = JSON.parse(process.env.AUTOPOD_PREVIEW_HEADERS_JSON || '{}');
const body = Buffer.from(process.env.AUTOPOD_PREVIEW_BODY_B64 || '', 'base64');
const hopByHop = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const headers = {};
for (const [name, value] of Object.entries(rawHeaders)) {
  const lower = name.toLowerCase();
  if (hopByHop.has(lower)) continue;
  if (Array.isArray(value)) headers[name] = value.map(String);
  else if (value != null) headers[name] = String(value);
}
headers.host = '127.0.0.1:' + port;
if (body.length > 0 && method !== 'GET' && method !== 'HEAD') {
  headers['content-length'] = String(body.length);
}
const req = http.request(
  { hostname: '127.0.0.1', port, path: requestPath, method, headers },
  (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => {
      process.stdout.write(JSON.stringify({
        statusCode: res.statusCode || 502,
        statusMessage: res.statusMessage || '',
        headers: res.headers,
        bodyBase64: Buffer.concat(chunks).toString('base64'),
      }));
    });
  },
);
req.setTimeout(timeoutMs, () => req.destroy(new Error('preview upstream timed out')));
req.on('error', (err) => {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(70);
});
if (body.length > 0 && method !== 'GET' && method !== 'HEAD') req.write(body);
req.end();
`;

export interface SandboxPreviewProxy {
  hostPort: number;
  url: string;
  close(): Promise<void>;
}

export interface SandboxPreviewProxyOptions {
  podId: string;
  containerId: string;
  hostPort: number;
  containerPort?: number;
  containerManager: ContainerManager;
  logger: Logger;
}

export interface SandboxPreviewFetchOptions {
  containerId: string;
  containerManager: ContainerManager;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  containerPort?: number;
  timeoutMs?: number;
}

export interface SandboxPreviewFetchResult {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export async function startSandboxPreviewProxy(
  options: SandboxPreviewProxyOptions,
): Promise<SandboxPreviewProxy> {
  const server = http.createServer((request, response) => {
    void proxyRequest(options, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.hostPort, '0.0.0.0');
  });

  const address = server.address() as AddressInfo;
  const hostPort = address.port;
  options.logger.info(
    { podId: options.podId, containerId: options.containerId, hostPort },
    'Sandbox preview proxy listening',
  );

  return {
    hostPort,
    url: `http://127.0.0.1:${hostPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

export async function fetchSandboxPreview(
  options: SandboxPreviewFetchOptions,
): Promise<SandboxPreviewFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const result = await options.containerManager.execInContainer(
    options.containerId,
    ['node', '-e', SANDBOX_PREVIEW_FETCH_SCRIPT],
    {
      timeout: timeoutMs + 5_000,
      env: {
        AUTOPOD_PREVIEW_METHOD: options.method,
        AUTOPOD_PREVIEW_PATH: normalizeRequestPath(options.path),
        AUTOPOD_PREVIEW_PORT: String(options.containerPort ?? DEFAULT_CONTAINER_PORT),
        AUTOPOD_PREVIEW_TIMEOUT_MS: String(timeoutMs),
        AUTOPOD_PREVIEW_HEADERS_JSON: JSON.stringify(filterForwardHeaders(options.headers)),
        AUTOPOD_PREVIEW_BODY_B64: options.body.toString('base64'),
      },
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `sandbox preview upstream failed with exit ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  let parsed: {
    statusCode?: unknown;
    statusMessage?: unknown;
    headers?: unknown;
    bodyBase64?: unknown;
  };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`sandbox preview returned invalid response: ${result.stdout.slice(0, 200)}`);
  }

  const statusCode = typeof parsed.statusCode === 'number' ? parsed.statusCode : 502;
  const statusMessage = typeof parsed.statusMessage === 'string' ? parsed.statusMessage : '';
  const headers = isHeaderRecord(parsed.headers) ? parsed.headers : {};
  const body =
    typeof parsed.bodyBase64 === 'string'
      ? Buffer.from(parsed.bodyBase64, 'base64')
      : Buffer.alloc(0);

  return { statusCode, statusMessage, headers, body };
}

async function proxyRequest(
  options: SandboxPreviewProxyOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const body = await readRequestBody(request);
    const upstream = await fetchSandboxPreview({
      containerId: options.containerId,
      containerManager: options.containerManager,
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body,
      containerPort: options.containerPort,
    });

    response.statusCode = upstream.statusCode;
    response.statusMessage = upstream.statusMessage;
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
      if (name.toLowerCase() === 'content-length') continue;
      response.setHeader(name, value);
    }
    response.setHeader('content-length', String(upstream.body.length));
    response.end(upstream.body);
  } catch (err) {
    options.logger.warn(
      { err, podId: options.podId, containerId: options.containerId, url: request.url },
      'Sandbox preview proxy request failed',
    );
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    response.end(err instanceof Error ? err.message : String(err));
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new Error(`preview request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function filterForwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    filtered[name] = Array.isArray(value) ? value : String(value);
  }
  return filtered;
}

function normalizeRequestPath(value: string): string {
  if (!value || value === '*') return '/';
  if (value.startsWith('/')) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function isHeaderRecord(value: unknown): value is Record<string, string | string[] | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return true;
}
