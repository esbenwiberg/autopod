import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { createGenericHttpHandler } from './generic-http-handler.js';

function mockResponse(
  data: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'application/json', ...opts.headers },
  });
}

const logger = pino({ level: 'silent' });

function makeAction(overrides: Partial<any> = {}): any {
  return {
    name: 'test_action',
    description: '',
    group: {} as any,
    handler: {} as any,
    params: {},
    response: { fields: [] },
    ...overrides,
  };
}

describe('createGenericHttpHandler', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws when endpoint config is missing', async () => {
    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await expect(
      handler.execute(makeAction({ endpoint: undefined }), {}),
    ).rejects.toThrow(/endpoint/i);
  });

  it('has handlerType "http"', () => {
    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });
    expect(handler.handlerType).toBe('http');
  });

  it('bearer auth resolves secret and sends correct header', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ ok: true }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: (ref) => (ref === 'MY_API_KEY' ? 'secret-token-xyz' : undefined),
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/data',
          method: 'GET',
          auth: { type: 'bearer', secret: '${MY_API_KEY}' },
        },
        response: { fields: [] },
      }),
      {},
    );

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const authHeader = (calledOpts.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe('Bearer secret-token-xyz');
  });

  it('basic auth resolves username and password secrets', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ ok: true }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: (ref) => {
        if (ref === 'USER') return 'admin';
        if (ref === 'PASS') return 'hunter2';
        return undefined;
      },
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/data',
          method: 'GET',
          auth: { type: 'basic', username: '${USER}', password: '${PASS}' },
        },
        response: { fields: [] },
      }),
      {},
    );

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const authHeader = (calledOpts.headers as Record<string, string>)['Authorization'];
    const expected = `Basic ${Buffer.from('admin:hunter2').toString('base64')}`;
    expect(authHeader).toBe(expected);
  });

  it('custom header auth sends the correct header', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ ok: true }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: (ref) => (ref === 'KEY' ? 'api-key-123' : undefined),
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/data',
          method: 'GET',
          auth: { type: 'custom-header', name: 'X-Api-Key', value: '${KEY}' },
        },
        response: { fields: [] },
      }),
      {},
    );

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const customHeader = (calledOpts.headers as Record<string, string>)['X-Api-Key'];
    expect(customHeader).toBe('api-key-123');
  });

  it('URL template expansion with path mapping', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ id: 42 }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/users/{{userId}}/posts/{{postId}}',
          method: 'GET',
          auth: { type: 'none' },
        },
        response: { fields: [] },
      }),
      { userId: '123', postId: '456' },
    );

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('/users/123/posts/456');
  });

  it('query string building appends to URL', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ results: [] }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/search',
          method: 'GET',
          auth: { type: 'none' },
        },
        request: {
          queryMapping: { q: '{{query}}', page: '{{page}}' },
        },
        response: { fields: [] },
      }),
      { query: 'hello world', page: '1' },
    );

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('q=hello');
    expect(calledUrl).toContain('page=1');
  });

  it('query string building works when URL already has ?', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ results: [] }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/search?version=2',
          method: 'GET',
          auth: { type: 'none' },
        },
        request: {
          queryMapping: { q: '{{query}}' },
        },
        response: { fields: [] },
      }),
      { query: 'test' },
    );

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('version=2');
    expect(calledUrl).toContain('q=test');
    // Should use & not a second ?
    expect(calledUrl.split('?').length).toBe(2);
  });

  it('body mapping for POST sends JSON body', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ created: true }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/items',
          method: 'POST',
          auth: { type: 'none' },
        },
        request: {
          bodyMapping: { title: '{{name}}', description: '{{desc}}' },
        },
        response: { fields: [] },
      }),
      { name: 'New Item', desc: 'A description' },
    );

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(calledOpts.method).toBe('POST');
    const bodyParsed = JSON.parse(calledOpts.body as string);
    expect(bodyParsed.title).toBe('New Item');
    expect(bodyParsed.description).toBe('A description');
  });

  it('resultPath resolution on response (e.g. "data.results")', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({
        data: {
          results: [
            { id: 1, name: 'Alpha', secret: 'x' },
            { id: 2, name: 'Beta', secret: 'y' },
          ],
        },
      }),
    );

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    const result: any = await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/items',
          method: 'GET',
          auth: { type: 'none' },
        },
        response: { resultPath: 'data.results', fields: ['id', 'name'] },
      }),
      {},
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 1, name: 'Alpha' });
    expect(result[1]).toEqual({ id: 2, name: 'Beta' });
  });

  it('field whitelisting filters out unlisted fields', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({
        id: 1,
        name: 'Public',
        secret: 'should-not-appear',
        internal: 'also-hidden',
      }),
    );

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    const result: any = await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/item/1',
          method: 'GET',
          auth: { type: 'none' },
        },
        response: { fields: ['id', 'name'] },
      }),
      {},
    );

    expect(result).toEqual({ id: 1, name: 'Public' });
    expect(result.secret).toBeUndefined();
    expect(result.internal).toBeUndefined();
  });

  it('throws when secret reference cannot be resolved', async () => {
    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await expect(
      handler.execute(
        makeAction({
          endpoint: {
            url: 'https://api.example.com/data',
            method: 'GET',
            auth: { type: 'bearer', secret: '${MISSING_SECRET}' },
          },
          response: { fields: [] },
        }),
        {},
      ),
    ).rejects.toThrow(/secret/i);
  });

  it('throws on HTTP error with status', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ error: 'Server Error' }, { status: 500 }),
    );

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await expect(
      handler.execute(
        makeAction({
          endpoint: {
            url: 'https://api.example.com/data',
            method: 'GET',
            auth: { type: 'none' },
          },
          response: { fields: [] },
        }),
        {},
      ),
    ).rejects.toThrow(/500/);
  });

  it('GET requests do not include a body', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ ok: true }));

    const handler = createGenericHttpHandler({
      logger,
      getSecret: () => undefined,
    });

    await handler.execute(
      makeAction({
        endpoint: {
          url: 'https://api.example.com/data',
          method: 'GET',
          auth: { type: 'none' },
        },
        response: { fields: [] },
      }),
      {},
    );

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(calledOpts.body).toBeUndefined();
  });
});
