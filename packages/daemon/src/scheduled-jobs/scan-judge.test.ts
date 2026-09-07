import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      expect.objectContaining({ maxRetries: 0, timeout: 15000, signal: expect.any(AbortSignal) }),
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
    await expect(createBoundedScanJudge(profile, {}, logger)('evidence')).rejects.toThrow(
      'incomplete',
    );
  });
});
