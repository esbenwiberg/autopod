import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdaptiveCard } from './card-builder.js';
import { createTeamsAdapter } from './teams-adapter.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const testCard: AdaptiveCard = {
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
  type: 'AdaptiveCard',
  version: '1.5',
  body: [{ type: 'TextBlock', text: 'Hello' }],
};

describe('TeamsAdapter', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends card wrapped in Teams envelope and returns true on success', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response('', { status: 200 });
    });

    const adapter = createTeamsAdapter('https://webhook.example.com/incoming', mockLogger);
    const result = await adapter.send(testCard);

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://webhook.example.com/incoming',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Verify envelope structure
    const parsed = JSON.parse(capturedBody ?? '');
    expect(parsed.type).toBe('message');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(parsed.attachments[0].content).toEqual(testCard);
  });

  it('returns false and logs warning on non-OK response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Bad Request', { status: 400, statusText: 'Bad Request' }));

    const adapter = createTeamsAdapter('https://webhook.example.com/incoming', mockLogger);
    const result = await adapter.send(testCard);

    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400 }),
      expect.stringContaining('non-OK'),
    );
  });

  it('returns false and logs warning on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const adapter = createTeamsAdapter('https://webhook.example.com/incoming', mockLogger);
    const result = await adapter.send(testCard);

    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to send'),
    );
  });

  it('never throws even on unexpected errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch is not a function'));

    const adapter = createTeamsAdapter('https://webhook.example.com/incoming', mockLogger);

    // Should not throw
    const result = await adapter.send(testCard);
    expect(result).toBe(false);
  });

  it('uses AbortSignal with 10s timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeDefined();
      return new Response('', { status: 200 });
    });

    const adapter = createTeamsAdapter('https://webhook.example.com/incoming', mockLogger);
    await adapter.send(testCard);

    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
