import type { Profile, ProviderCredentials } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  ContainerReviewerUnavailableError,
  resolveContainerReviewer,
  runContainerReviewer,
} from '../validation/container-reviewer-runner.js';
import { getAzureToken } from './azure-token.js';
import {
  type ProfileLlmClientUnavailableReason,
  createProfileAnthropicClient,
} from './llm-client.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_REVIEWER_MODEL = 'gpt-5-mini';
const DEFAULT_FOUNDRY_OPENAI_API_VERSION = '2024-12-01-preview';
const FOUNDRY_TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

export interface MemoryReviewer {
  model: string;
  generateText(input: {
    systemPrompt: string;
    userMessage: string;
    maxTokens: number;
  }): Promise<string>;
}

export type MemoryReviewerUnavailableReason =
  | ProfileLlmClientUnavailableReason
  | 'openai_auth_unavailable'
  | 'foundry_openai_auth_unavailable'
  | 'provider_not_callable'
  | string;

export type MemoryReviewerResult =
  | { ok: true; reviewer: MemoryReviewer; model: string }
  | { ok: false; reason: MemoryReviewerUnavailableReason };

export interface ContainerMemoryReviewerOptions {
  podId: string;
  containerId: string | null | undefined;
  containerManager: ContainerManager;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

function parseOpenAiAuthJson(authJson: string | undefined): string | null {
  if (!authJson) return null;
  try {
    const parsed = JSON.parse(authJson) as {
      OPENAI_API_KEY?: string | null;
      tokens?: {
        access_token?: string | null;
      };
    };
    return parsed.OPENAI_API_KEY ?? parsed.tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function fetchChatCompletion(input: {
  url: string;
  headers: Record<string, string>;
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
}): Promise<string> {
  const response = await fetch(input.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...input.headers,
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userMessage },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`openai_reviewer_http_${response.status}: ${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as ChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('openai_reviewer_empty_response');
  return content;
}

function openAiReviewer(input: {
  model: string;
  token: string;
  baseUrl?: string;
}): MemoryReviewer {
  const baseUrl = trimTrailingSlash(input.baseUrl ?? DEFAULT_OPENAI_BASE_URL);
  const model = input.model === 'auto' ? DEFAULT_OPENAI_REVIEWER_MODEL : input.model;
  return {
    model,
    generateText: ({ systemPrompt, userMessage, maxTokens }) =>
      fetchChatCompletion({
        url: `${baseUrl}/chat/completions`,
        headers: { authorization: `Bearer ${input.token}` },
        model,
        systemPrompt,
        userMessage,
        maxTokens,
      }),
  };
}

function foundryOpenAiReviewer(input: {
  model: string;
  endpoint: string;
  apiVersion?: string;
  secret: string;
  authMode: 'api-key' | 'bearer';
}): MemoryReviewer {
  const endpoint = trimTrailingSlash(input.endpoint);
  const apiVersion = input.apiVersion ?? DEFAULT_FOUNDRY_OPENAI_API_VERSION;
  const headers =
    input.authMode === 'api-key'
      ? { 'api-key': input.secret }
      : { authorization: `Bearer ${input.secret}` };
  return {
    model: input.model,
    generateText: ({ systemPrompt, userMessage, maxTokens }) =>
      fetchChatCompletion({
        url: `${endpoint}/openai/deployments/${encodeURIComponent(
          input.model,
        )}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
        headers,
        model: input.model,
        systemPrompt,
        userMessage,
        maxTokens,
      }),
  };
}

function isOpenAiSurface(creds: ProviderCredentials | null | undefined): boolean {
  return creds?.provider === 'foundry' && (creds.apiSurface ?? 'anthropic') === 'openai';
}

export async function createProfileMemoryReviewer(
  profile: Profile,
  reviewerModel: string,
  logger: Logger,
  options: { container?: ContainerMemoryReviewerOptions } = {},
): Promise<MemoryReviewerResult> {
  if (options.container) {
    return createContainerFirstMemoryReviewer(profile, reviewerModel, logger, options.container);
  }
  return createDaemonMemoryReviewer(profile, reviewerModel, logger);
}

async function createContainerFirstMemoryReviewer(
  profile: Profile,
  reviewerModel: string,
  logger: Logger,
  container: ContainerMemoryReviewerOptions,
): Promise<MemoryReviewerResult> {
  const containerRunner = resolveContainerReviewer(profile);

  if (typeof containerRunner !== 'string') {
    const daemonResult = await safeCreateDaemonMemoryReviewer(profile, reviewerModel, logger);
    if (daemonResult.ok) return daemonResult;
    return {
      ok: false,
      reason: combineUnavailableReasons(
        `container_reviewer_unavailable: provider ${containerRunner.provider} is not supported`,
        `daemon_reviewer_unavailable: ${daemonResult.reason}`,
      ),
    };
  }

  if (!container.containerId) {
    const daemonResult = await safeCreateDaemonMemoryReviewer(profile, reviewerModel, logger);
    if (daemonResult.ok) return daemonResult;
    return {
      ok: false,
      reason: combineUnavailableReasons(
        'container_reviewer_unavailable: pod has no live container',
        `daemon_reviewer_unavailable: ${daemonResult.reason}`,
      ),
    };
  }

  const model =
    reviewerModel === 'auto' && profile.modelProvider === 'openai'
      ? DEFAULT_OPENAI_REVIEWER_MODEL
      : reviewerModel;

  return {
    ok: true,
    model,
    reviewer: {
      model,
      async generateText(input) {
        try {
          const result = await runContainerReviewer({
            podId: container.podId,
            containerId: container.containerId,
            containerManager: container.containerManager,
            profile,
            model,
            prompt: buildMemoryReviewPrompt(input.systemPrompt, input.userMessage),
            env: container.env,
            timeout: container.timeoutMs ?? 20_000,
            logger,
          });
          return result.stdout;
        } catch (err) {
          const containerReason = `container_reviewer_unavailable: ${reasonFromError(err)}`;
          logger.warn(
            { podId: container.podId, reason: containerReason },
            'Container memory reviewer unavailable',
          );
          const daemonResult = await safeCreateDaemonMemoryReviewer(profile, reviewerModel, logger);
          if (daemonResult.ok) {
            return daemonResult.reviewer.generateText(input);
          }
          throw new ContainerReviewerUnavailableError(
            combineUnavailableReasons(
              containerReason,
              `daemon_reviewer_unavailable: ${daemonResult.reason}`,
            ),
            { cause: err },
          );
        }
      },
    },
  };
}

async function safeCreateDaemonMemoryReviewer(
  profile: Profile,
  reviewerModel: string,
  logger: Logger,
): Promise<MemoryReviewerResult> {
  try {
    return await createDaemonMemoryReviewer(profile, reviewerModel, logger);
  } catch (err) {
    return {
      ok: false,
      reason: `daemon_reviewer_failed: ${reasonFromError(err)}`,
    };
  }
}

async function createDaemonMemoryReviewer(
  profile: Profile,
  reviewerModel: string,
  logger: Logger,
): Promise<MemoryReviewerResult> {
  if (profile.modelProvider === 'openai') {
    const creds = profile.providerCredentials;
    const token =
      process.env.OPENAI_API_KEY ??
      (creds?.provider === 'openai' ? parseOpenAiAuthJson(creds.authJson) : null);
    if (!token) return { ok: false, reason: 'openai_auth_unavailable' };
    return {
      ok: true,
      model: reviewerModel === 'auto' ? DEFAULT_OPENAI_REVIEWER_MODEL : reviewerModel,
      reviewer: openAiReviewer({
        model: reviewerModel,
        token,
        baseUrl: process.env.OPENAI_BASE_URL,
      }),
    };
  }

  if (isOpenAiSurface(profile.providerCredentials)) {
    const creds = profile.providerCredentials;
    if (!creds || creds.provider !== 'foundry') {
      return { ok: false, reason: 'foundry_openai_auth_unavailable' };
    }
    const token = creds.apiKey ?? (await getAzureToken(FOUNDRY_TOKEN_SCOPE, logger)).token;
    return {
      ok: true,
      model: reviewerModel,
      reviewer: foundryOpenAiReviewer({
        model: reviewerModel,
        endpoint: creds.endpoint,
        apiVersion: creds.apiVersion,
        secret: token,
        authMode: creds.apiKey ? 'api-key' : 'bearer',
      }),
    };
  }

  const anthropic = await createProfileAnthropicClient(profile, reviewerModel, logger);
  if (!anthropic.ok) return anthropic;
  return {
    ok: true,
    model: anthropic.model,
    reviewer: {
      model: anthropic.model,
      async generateText({ systemPrompt, userMessage, maxTokens }) {
        const response = await anthropic.client.messages.create({
          model: anthropic.model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });
        const textBlock = response.content.find(
          (block): block is { type: 'text'; text: string } => block.type === 'text',
        );
        return textBlock?.text ?? '';
      },
    },
  };
}

function buildMemoryReviewPrompt(systemPrompt: string, userMessage: string): string {
  return `${systemPrompt.trim()}\n\n${userMessage.trim()}`;
}

function combineUnavailableReasons(...reasons: Array<string | null | undefined>): string {
  return reasons.filter(Boolean).join('; ');
}

function reasonFromError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
