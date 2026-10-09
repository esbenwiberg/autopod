import { describe, expect, it } from 'vitest';
import {
  foundryAnthropicBaseUrl,
  foundryCodexConfigArgs,
  foundryEndpointHost,
  foundryOpenAiBaseUrl,
} from './foundry-endpoint.js';

describe('foundryEndpointHost', () => {
  it.each([
    ['https://res.services.ai.azure.com/anthropic', 'res.services.ai.azure.com'],
    ['https://RES.openai.azure.com', 'res.openai.azure.com'],
    ['https://res.cognitiveservices.azure.com/', 'res.cognitiveservices.azure.com'],
  ])('returns the canonical host for %s', (endpoint, host) => {
    expect(foundryEndpointHost(endpoint)).toBe(host);
  });

  it.each([
    'not a url',
    'http://res.services.ai.azure.com',
    'https://res.services.ai.azure.com:444',
    'https://services.ai.azure.com.evil.example',
    'https://evil.example/res.services.ai.azure.com',
    'https://gateway.example.com',
  ])('rejects %s', (endpoint) => {
    expect(foundryEndpointHost(endpoint)).toBeNull();
  });
});

describe('foundryAnthropicBaseUrl', () => {
  it.each([
    ['https://res.services.ai.azure.com', 'https://res.services.ai.azure.com/anthropic'],
    ['https://res.services.ai.azure.com/', 'https://res.services.ai.azure.com/anthropic'],
    ['https://res.services.ai.azure.com/anthropic', 'https://res.services.ai.azure.com/anthropic'],
    ['https://res.services.ai.azure.com/anthropic/', 'https://res.services.ai.azure.com/anthropic'],
    [
      'https://res.services.ai.azure.com/anthropic/v1/messages',
      'https://res.services.ai.azure.com/anthropic',
    ],
    [
      'https://res.services.ai.azure.com/anthropic/v1',
      'https://res.services.ai.azure.com/anthropic',
    ],
    ['https://gateway.example.com/claude', 'https://gateway.example.com/claude'],
  ])('normalises %s', (endpoint, expected) => {
    expect(foundryAnthropicBaseUrl(endpoint)).toBe(expected);
  });

  it('drops query strings and fragments', () => {
    expect(foundryAnthropicBaseUrl('https://res.services.ai.azure.com/anthropic?x=1#y')).toBe(
      'https://res.services.ai.azure.com/anthropic',
    );
  });
});

describe('foundryOpenAiBaseUrl', () => {
  it.each([
    ['https://res.services.ai.azure.com', 'https://res.services.ai.azure.com/openai/v1'],
    ['https://res.openai.azure.com/', 'https://res.openai.azure.com/openai/v1'],
    ['https://res.openai.azure.com/openai', 'https://res.openai.azure.com/openai/v1'],
    ['https://res.openai.azure.com/openai/v1/', 'https://res.openai.azure.com/openai/v1'],
    ['https://res.openai.azure.com/openai/v1/responses', 'https://res.openai.azure.com/openai/v1'],
    [
      'https://res.openai.azure.com/openai/v1/chat/completions?api-version=preview',
      'https://res.openai.azure.com/openai/v1',
    ],
    ['https://gateway.example.com/llm/v1', 'https://gateway.example.com/llm/v1'],
  ])('normalises %s', (endpoint, expected) => {
    expect(foundryOpenAiBaseUrl(endpoint)).toBe(expected);
  });
});

describe('foundryCodexConfigArgs', () => {
  it('selects the Azure provider when the env carries the Foundry marker', () => {
    expect(
      foundryCodexConfigArgs({
        AUTOPOD_CODEX_MODEL_PROVIDER: 'azure-foundry',
        OPENAI_BASE_URL: 'https://res.services.ai.azure.com/openai/v1',
      }),
    ).toEqual([
      '-c',
      'model_provider="azure-foundry"',
      '-c',
      'model_providers.azure-foundry.name="Azure AI Foundry"',
      '-c',
      'model_providers.azure-foundry.base_url="https://res.services.ai.azure.com/openai/v1"',
      '-c',
      'model_providers.azure-foundry.env_key="OPENAI_API_KEY"',
      '-c',
      'model_providers.azure-foundry.wire_api="responses"',
      '-c',
      'model_providers.azure-foundry.supports_websockets=false',
    ]);
  });

  it.each([undefined, {}, { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }])(
    'adds nothing for non-Foundry env %o',
    (env) => {
      expect(foundryCodexConfigArgs(env)).toEqual([]);
    },
  );

  it('refuses the Foundry marker without a base URL', () => {
    expect(() => foundryCodexConfigArgs({ AUTOPOD_CODEX_MODEL_PROVIDER: 'azure-foundry' })).toThrow(
      'without OPENAI_BASE_URL',
    );
  });
});
