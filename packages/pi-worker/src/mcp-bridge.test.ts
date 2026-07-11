import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverMcpTools } from './mcp-bridge.js';
import type { PiWorkerConfig } from './types.js';

interface RecordedHttpCall {
  method: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      resolve(body.length > 0 ? JSON.parse(body) : {});
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startHttpMcpServer(options: {
  toolName: string;
  schema: Record<string, unknown>;
  resultText: string;
}) {
  const calls: RecordedHttpCall[] = [];
  let aborted = false;
  let longCallStarted: (() => void) | undefined;
  const sessionId = 'test-session-id';
  const longCall = new Promise<void>((resolve) => {
    longCallStarted = resolve;
  });
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method ?? 'GET', headers: req.headers, body });
    const rpc = body as { id?: string | number; method?: string; params?: { name?: string } };
    if (rpc.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', sessionId);
      sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } });
      return;
    }
    if (req.headers['mcp-session-id'] !== sessionId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('missing MCP session header');
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (rpc.method === 'tools/list') {
      sendJson(res, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          tools: [
            {
              name: options.toolName,
              description: `${options.toolName} description`,
              inputSchema: options.schema,
            },
            {
              name: 'wait_for_human',
              inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
            },
          ],
        },
      });
      return;
    }
    if (rpc.method === 'tools/call' && rpc.params?.name === 'wait_for_human') {
      res.on('close', () => {
        aborted = true;
        res.destroy();
      });
      longCallStarted?.();
      return;
    }
    if (rpc.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progress: 1 },
        })}\n\n`,
      );
      res.end(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            content: [
              { type: 'text', text: `${options.resultText}:${JSON.stringify(rpc.params)}` },
            ],
          },
        })}\n\n`,
      );
      return;
    }
    sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    waitForLongCall: () => longCall,
    wasAborted: () => aborted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function createStdioMcpFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'autopod-pi-worker-'));
  const logPath = path.join(dir, 'stdio-log.jsonl');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = process.argv[1];
const rl = readline.createInterface({ input: process.stdin });
function write(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.method === 'initialize') {
    write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
  } else if (msg.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'stdio_lookup',
          description: 'stdio lookup',
          inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
        }]
      }
    });
  } else if (msg.method === 'tools/call') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'stdio:' + JSON.stringify(msg.params) }] }
    });
  }
});
`;
  return {
    dir,
    logPath,
    command: process.execPath,
    args: ['-e', script, logPath],
    readLog: async () =>
      (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('MCP bridge', () => {
  it('forwards HTTP and stdio tools with headers, schemas, arguments, and distinct results', async () => {
    const http = await startHttpMcpServer({
      toolName: 'http_lookup',
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      resultText: 'http',
    });
    const stdio = await createStdioMcpFixture();
    const config: PiWorkerConfig = {
      requiredServerName: 'autopod',
      mcpServers: [
        {
          type: 'http',
          name: 'autopod',
          url: http.url,
          headers: { Authorization: 'Bearer test-token', 'X-Autopod-Pod': 'lucky-kiwi' },
        },
        { type: 'stdio', name: 'code-nav', command: stdio.command, args: stdio.args },
      ],
    };

    try {
      const { tools, clients } = await discoverMcpTools(config);
      const httpTool = tools.find((tool) => tool.piName === 'http_lookup');
      const stdioTool = tools.find((tool) => tool.piName === 'stdio_lookup');
      expect(httpTool?.inputSchema).toEqual(
        config.mcpServers[0]?.type === 'http'
          ? { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
          : undefined,
      );
      expect(stdioTool?.inputSchema).toEqual({
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      });

      const httpResult = await httpTool?.call({ query: 'status' });
      const stdioResult = await stdioTool?.call({ id: 42 });
      expect(httpResult?.content?.[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('"query":"status"') }),
      );
      expect(stdioResult?.content?.[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('"id":42') }),
      );
      expect(String(http.calls[0]?.headers.authorization)).toBe('Bearer test-token');
      expect(String(http.calls[0]?.headers['x-autopod-pod'])).toBe('lucky-kiwi');
      expect(http.calls.some((call) => call.headers['mcp-session-id'] === 'test-session-id')).toBe(
        true,
      );
      expect((await stdio.readLog()).some((entry) => entry.method === 'tools/call')).toBe(true);
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      await http.close();
      await stdio.cleanup();
    }
  });

  it('cancels long-running calls without applying a short default timeout', async () => {
    const http = await startHttpMcpServer({
      toolName: 'http_lookup',
      schema: { type: 'object', properties: {} },
      resultText: 'http',
    });
    const config: PiWorkerConfig = {
      requiredServerName: 'autopod',
      mcpServers: [{ type: 'http', name: 'autopod', url: http.url }],
    };

    try {
      const { tools, clients } = await discoverMcpTools(config);
      const longTool = tools.find((tool) => tool.piName === 'wait_for_human');
      if (!longTool) throw new Error('long-running tool was not discovered');
      const controller = new AbortController();
      const call = longTool.call({ prompt: 'approval needed' }, controller.signal);
      await http.waitForLongCall();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(http.wasAborted()).toBe(false);
      controller.abort();
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(http.wasAborted()).toBe(true);
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      await http.close();
    }
  });
});
