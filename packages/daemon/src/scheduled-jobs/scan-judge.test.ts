import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderAnthropicClient } from '../providers/llm-client.js';
import { createBoundedScanJudge } from './scan-judge.js';

vi.mock('../providers/llm-client.js', () => ({ createProviderAnthropicClient: vi.fn() }));
const logger = pino({ level: 'silent' });
const profile = {
  name: 'scan-fixture',
  modelProvider: 'max',
  defaultModel: 'bound-model',
  providerCredentials: { provider: 'max', oauthToken: 'synthetic-fixture' },
} as Profile;
describe('bounded report judgment without worker authority', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('ends a hung credential acquisition without reviving a late judgment request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let release:
      | ((value: Awaited<ReturnType<typeof createProviderAnthropicClient>>) => void)
      | undefined;
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Late output' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    vi.mocked(createProviderAnthropicClient).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const pending = createBoundedScanJudge(
      profile,
      {},
      logger,
    )('evidence').then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(15001);
    const bounded = settled;
    release?.({ ok: true, client: { messages: { create } }, model: 'bound-model' } as never);
    await pending;
    expect(bounded).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(createProviderAnthropicClient).toHaveBeenCalledOnce();
  });
  it.each(['truncated', 'oversized', 'empty', 'late'] as const)(
    'retains measured usage when judgment output is %s',
    async (mode) => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const create = vi.fn().mockImplementation(async () => {
        now = mode === 'late' ? 15001 : 14500;
        return {
          content: [
            {
              type: 'text',
              text:
                mode === 'oversized'
                  ? 'x'.repeat(16001)
                  : mode === 'empty'
                    ? ' '
                    : 'Observed output',
            },
          ],
          stop_reason: mode === 'truncated' ? 'max_tokens' : 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      });
      vi.mocked(createProviderAnthropicClient).mockImplementation(async () => {
        now = 14000;
        return { ok: true, client: { messages: { create } }, model: 'bound-model' } as never;
      });
      const result = await createBoundedScanJudge(profile, {}, logger)('evidence');
      expect(result.status).toBe('unavailable');
      expect(result.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
        durationMs: now,
        model: 'bound-model',
        provider: 'max',
      });
      expect(create.mock.calls[0]?.[1]).toMatchObject({ timeout: 1000, maxRetries: 0 });
      expect(create).toHaveBeenCalledOnce();
      expect(result.text).not.toContain('Observed output');
    },
  );
  it('freezes the selected model and requests no tools, no retries, bounded output and timeout', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Review the finding.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    vi.mocked(createProviderAnthropicClient).mockResolvedValue({
      ok: true,
      model: 'bound-model',
      client: { messages: { create } },
    } as never);
    const mutable = structuredClone(profile);
    const judge = createBoundedScanJudge(mutable, {}, logger);
    mutable.defaultModel = 'changed-after-collection';
    mutable.modelProvider = 'anthropic';
    const result = await judge('{"status":"incomplete"}');
    expect(createProviderAnthropicClient).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'max', model: 'bound-model' }),
      logger,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 2048 }),
      expect.objectContaining({
        maxRetries: 0,
        timeout: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tools');
    expect(result).toMatchObject({
      status: 'complete',
      usage: {
        model: 'bound-model',
        provider: 'max',
        costUsd: null,
        inputTokens: 10,
        outputTokens: 5,
      },
    });
  });
  it('fails closed for absent binding, oversized input or truncated judgment', async () => {
    await expect(
      createBoundedScanJudge(
        { ...profile, modelProvider: null } as Profile,
        {},
        logger,
      )('evidence'),
    ).rejects.toThrow('binding');
    await expect(createBoundedScanJudge(profile, {}, logger)('x'.repeat(60001))).rejects.toThrow(
      'binding',
    );
    expect(createProviderAnthropicClient).not.toHaveBeenCalled();
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Partial' }],
      stop_reason: 'max_tokens',
      usage: {},
    }));
    vi.mocked(createProviderAnthropicClient).mockResolvedValue({
      ok: true,
      model: 'bound-model',
      client: { messages: { create } },
    } as never);
    await expect(createBoundedScanJudge(profile, {}, logger)('evidence')).resolves.toMatchObject({
      status: 'unavailable',
      text: expect.stringContaining('Response usage is unavailable.'),
    });
  });
});
