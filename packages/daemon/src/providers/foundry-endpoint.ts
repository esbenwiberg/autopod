import { AutopodError } from '@autopod/shared';

/**
 * Foundry endpoint helpers shared by the container env builder, daemon-side
 * LLM clients, Codex launchers, and network allowlisting.
 */

/**
 * Env marker telling Codex launchers to route through a Foundry model
 * provider. Codex ignores `OPENAI_BASE_URL`; it only leaves api.openai.com when
 * its config selects a custom `model_providers` entry.
 */
export const CODEX_MODEL_PROVIDER_ENV = 'AUTOPOD_CODEX_MODEL_PROVIDER';
export const CODEX_FOUNDRY_PROVIDER = 'azure-foundry';

/**
 * Codex `model_providers.azure-foundry` settings for a provider env, or
 * `undefined` when the env does not select Foundry. The agent shim expands
 * `OPENAI_API_KEY` from its secret file and Azure accepts it as a Bearer token.
 * HTTP transport avoids depending on WebSocket support through restricted
 * egress proxies. A marker without a base URL throws rather than letting Codex
 * fall back to api.openai.com.
 */
export function foundryCodexProviderSettings(
  env: Record<string, string> | undefined,
): Array<[string, string | boolean]> | undefined {
  if (env?.[CODEX_MODEL_PROVIDER_ENV] !== CODEX_FOUNDRY_PROVIDER) return undefined;
  const baseUrl = env.OPENAI_BASE_URL?.trim();
  if (!baseUrl) {
    throw new AutopodError(
      'Foundry Codex provider selected without OPENAI_BASE_URL',
      'PROVIDER_ACCOUNT_ENDPOINT_INVALID',
      500,
    );
  }
  return [
    ['name', 'Azure AI Foundry'],
    ['base_url', baseUrl],
    ['env_key', 'OPENAI_API_KEY'],
    ['wire_api', 'responses'],
    ['supports_websockets', false],
  ];
}

/**
 * `-c key=value` overrides selecting the Foundry provider, for Codex launches
 * that run with `--ignore-user-config` (isolated reviewers, system decisions)
 * and therefore never read `config.toml`. Values are TOML literals; callers
 * must shell-quote each element when building a shell string.
 */
export function foundryCodexConfigArgs(env: Record<string, string> | undefined): string[] {
  const settings = foundryCodexProviderSettings(env);
  if (!settings) return [];
  return [
    '-c',
    `model_provider=${JSON.stringify(CODEX_FOUNDRY_PROVIDER)}`,
    ...settings.flatMap(([key, value]) => [
      '-c',
      `model_providers.${CODEX_FOUNDRY_PROVIDER}.${key}=${JSON.stringify(value)}`,
    ]),
  ];
}

const FOUNDRY_HOST_SUFFIXES = [
  '.services.ai.azure.com',
  '.openai.azure.com',
  '.cognitiveservices.azure.com',
];

/**
 * Returns the lowercase hostname when `endpoint` is an https Azure Foundry
 * host on the default port, otherwise `null`. Used to decide whether the
 * endpoint may be auto-added to a restricted egress allowlist — custom
 * gateways must be allowlisted explicitly by the profile.
 */
export function foundryEndpointHost(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port) return null;
  return FOUNDRY_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ? hostname : null;
}

/**
 * Normalizes a user-supplied Foundry endpoint into the Anthropic base URL that
 * Claude Code (`ANTHROPIC_FOUNDRY_BASE_URL`) and the Anthropic SDK expect:
 * `https://{resource}.services.ai.azure.com/anthropic`.
 *
 * Accepts the resource root, the `/anthropic` base, or a pasted portal
 * "Target URI" ending in `/v1/messages`. Any other path is kept as-is so
 * custom Anthropic-compatible gateways keep working.
 */
export function foundryAnthropicBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/v1(\/messages)?$/, '');
  if (path === '') path = '/anthropic';
  return `${url.origin}${path}`;
}

/**
 * Normalizes a Foundry endpoint into the OpenAI-compatible v1 base URL that
 * Codex (`OPENAI_BASE_URL`) appends `/responses` to:
 * `https://{resource}.services.ai.azure.com/openai/v1`. The bare resource
 * root 404s on `/responses`; Azure serves the v1 API under `/openai/v1`.
 *
 * Accepts the resource root, `/openai`, `/openai/v1`, or a pasted URL ending
 * in `/responses` or `/chat/completions`. Any other path is kept as-is for
 * custom OpenAI-compatible gateways.
 */
export function foundryOpenAiBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(responses|chat\/completions)$/, '');
  if (path === '' || path === '/openai') path = '/openai/v1';
  return `${url.origin}${path}`;
}
