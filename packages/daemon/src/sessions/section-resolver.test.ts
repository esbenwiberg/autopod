import type { InjectedClaudeMdSection } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSections } from './section-resolver.js';

const logger = pino({ level: 'silent' });

describe('resolveSections', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns empty array for empty input', async () => {
    const result = await resolveSections([], logger);
    expect(result).toEqual([]);
  });

  it('resolves static content sections', async () => {
    const sections: InjectedClaudeMdSection[] = [
      { heading: 'Rules', content: 'Always write tests', priority: 10 },
    ];
    const result = await resolveSections(sections, logger);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      heading: 'Rules',
      content: 'Always write tests',
      priority: 10,
    });
  });

  it('uses default priority 50 when not specified', async () => {
    const sections: InjectedClaudeMdSection[] = [{ heading: 'Rules', content: 'test' }];
    const result = await resolveSections(sections, logger);
    expect(result[0]?.priority).toBe(50);
  });

  it('fetches dynamic content', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Dynamic content here', { status: 200 }));

    const sections: InjectedClaudeMdSection[] = [
      {
        heading: 'Architecture',
        fetch: { url: 'https://prism.io/api/context', timeoutMs: 5000 },
      },
    ];

    const result = await resolveSections(sections, logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('Dynamic content here');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://prism.io/api/context',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('combines static and dynamic content', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('fetched part', { status: 200 }));

    const sections: InjectedClaudeMdSection[] = [
      {
        heading: 'Context',
        content: 'static part',
        fetch: { url: 'https://api.example.com/context' },
      },
    ];

    const result = await resolveSections(sections, logger);
    expect(result[0]?.content).toBe('static part\n\nfetched part');
  });

  it('sends authorization header when configured', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const sections: InjectedClaudeMdSection[] = [
      {
        heading: 'Private',
        fetch: {
          url: 'https://api.example.com/private',
          authorization: 'Bearer secret123',
        },
      },
    ];

    await resolveSections(sections, logger);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/private',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret123' }),
      }),
    );
  });

  it('skips section when fetch fails and no static content', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Not found', { status: 404 }));

    const sections: InjectedClaudeMdSection[] = [
      { heading: 'Missing', fetch: { url: 'https://api.example.com/404' } },
    ];

    const result = await resolveSections(sections, logger);
    expect(result).toHaveLength(0);
  });

  it('falls back to static content when fetch fails', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Not found', { status: 404 }));

    const sections: InjectedClaudeMdSection[] = [
      {
        heading: 'Fallback',
        content: 'fallback content',
        fetch: { url: 'https://api.example.com/404' },
      },
    ];

    const result = await resolveSections(sections, logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('fallback content');
  });

  it('falls back to static content on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const sections: InjectedClaudeMdSection[] = [
      {
        heading: 'Offline',
        content: 'static fallback',
        fetch: { url: 'https://api.example.com/down' },
      },
    ];

    const result = await resolveSections(sections, logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('static fallback');
  });

  it('truncates long dynamic content to token budget', async () => {
    const longText = 'x'.repeat(20_000); // 20k chars = ~5000 tokens
    fetchSpy.mockResolvedValueOnce(new Response(longText, { status: 200 }));

    const sections: InjectedClaudeMdSection[] = [
      {
        heading: 'Long',
        fetch: { url: 'https://api.example.com/long' },
        maxTokens: 1000, // 1000 tokens * 4 chars = 4000 chars max
      },
    ];

    const result = await resolveSections(sections, logger);
    expect(result[0]?.content.length).toBeLessThanOrEqual(4000 + 20); // +buffer for "(truncated)" suffix
    expect(result[0]?.content).toContain('(truncated)');
  });

  it('resolves multiple sections in parallel', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('section 1', { status: 200 }))
      .mockResolvedValueOnce(new Response('section 2', { status: 200 }));

    const sections: InjectedClaudeMdSection[] = [
      { heading: 'A', fetch: { url: 'https://api.example.com/a' }, priority: 1 },
      { heading: 'B', fetch: { url: 'https://api.example.com/b' }, priority: 2 },
    ];

    const result = await resolveSections(sections, logger);
    expect(result).toHaveLength(2);
  });
});
