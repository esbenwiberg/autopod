import {
  type CompiledProviderManifest,
  PROVIDER_MANIFEST_VERSION,
} from '../types/provider-catalog.js';
import { createProviderCatalog } from './provider-catalog.js';

const legacy = (
  id: string,
  displayName: string,
  adapterId: string,
  credentialKind: 'api-key' | 'oauth' | 'managed-identity' | 'opaque',
): CompiledProviderManifest['providers'][number] => ({
  id,
  displayName,
  description: `${displayName} compatibility provider`,
  implementation: { kind: 'legacy', adapterId },
  credentialOptions: [
    {
      kind: credentialKind,
      label: 'Existing Autopod credentials',
      acquisition: 'Continue using the existing provider account or profile credential flow.',
    },
  ],
  modelIds: [],
  requiredHosts: [],
  policy: { lifecycle: 'active', authorization: 'supported', runnable: true, caveats: [] },
});

export const COMPILED_PROVIDER_MANIFEST = {
  manifestVersion: PROVIDER_MANIFEST_VERSION,
  piCompatibility: {
    packageName: '@earendil-works/pi-coding-agent',
    packageVersion: '0.80.6',
    source: 'pinned-distribution',
  },
  providers: [
    legacy('anthropic', 'Anthropic API', 'anthropic', 'api-key'),
    legacy('max', 'Claude MAX/PRO', 'max', 'oauth'),
    legacy('openai', 'OpenAI', 'openai', 'opaque'),
    legacy('foundry', 'Azure AI Foundry', 'foundry', 'managed-identity'),
    legacy('copilot', 'GitHub Copilot', 'copilot', 'oauth'),
    legacy('openrouter', 'OpenRouter', 'openrouter', 'api-key'),
    legacy('pi', 'Pi OAuth', 'pi-oauth', 'opaque'),
    {
      id: 'opencode-zen',
      displayName: 'OpenCode Zen',
      description: 'OpenCode Zen models through the managed Pi runtime.',
      implementation: { kind: 'generic-pi-api', piProviderId: 'opencode' },
      credentialOptions: [
        {
          kind: 'api-key',
          label: 'OpenCode Zen API key',
          acquisition: 'Create an API key in OpenCode Zen after unattended use is authorized.',
        },
      ],
      modelIds: ['opencode/claude-sonnet-4-5'],
      requiredHosts: ['opencode.ai'],
      policy: {
        lifecycle: 'experimental',
        authorization: 'authorization-pending',
        runnable: false,
        caveats: [
          {
            kind: 'subscription',
            severity: 'blocking',
            message: 'Unattended Autopod use is pending provider authorization.',
          },
          {
            kind: 'privacy',
            severity: 'warning',
            message: 'Review current provider privacy and retention terms before enabling.',
          },
        ],
      },
    },
    {
      id: 'opencode-go',
      displayName: 'OpenCode Go',
      description: 'OpenCode Go subscription models through the managed Pi runtime.',
      implementation: { kind: 'generic-pi-api', piProviderId: 'opencode-go' },
      credentialOptions: [
        {
          kind: 'api-key',
          label: 'OpenCode Go API key',
          acquisition: 'Create an API key in OpenCode Go after unattended use is authorized.',
        },
      ],
      modelIds: ['opencode-go/kimi-k2.5'],
      requiredHosts: ['opencode.ai'],
      policy: {
        lifecycle: 'experimental',
        authorization: 'authorization-pending',
        runnable: false,
        caveats: [
          {
            kind: 'subscription',
            severity: 'blocking',
            message: 'Unattended Autopod use is pending provider authorization.',
          },
          {
            kind: 'metered-fallback',
            severity: 'warning',
            message:
              'Optional metered fallback may incur usage charges; Autopod never enables it automatically.',
          },
        ],
      },
    },
    {
      id: 'kimi-code',
      displayName: 'Kimi Code membership',
      description: 'Kimi Code membership through the managed Pi runtime.',
      implementation: { kind: 'generic-pi-api', piProviderId: 'kimi-coding' },
      credentialOptions: [
        {
          kind: 'api-key',
          label: 'Manually created Kimi Code API key',
          acquisition: 'Use only after Kimi explicitly authorizes unattended Autopod-like use.',
        },
      ],
      modelIds: ['kimi-coding/k2p5'],
      requiredHosts: ['api.kimi.com'],
      policy: {
        lifecycle: 'experimental',
        authorization: 'blocked',
        runnable: false,
        caveats: [
          {
            kind: 'subscription',
            severity: 'blocking',
            message: 'Blocked pending explicit Kimi authorization for unattended Autopod use.',
          },
          {
            kind: 'retention',
            severity: 'warning',
            message: 'Review current Kimi data retention terms before any future enablement.',
          },
        ],
      },
    },
    {
      id: 'kimi-api',
      displayName: 'Kimi API',
      description:
        'Metered Moonshot AI API access; technically compatible but not the preferred procurement path.',
      implementation: { kind: 'generic-pi-api', piProviderId: 'moonshotai' },
      credentialOptions: [
        {
          kind: 'api-key',
          label: 'Moonshot AI API key',
          acquisition: 'Create a metered API key in the Moonshot AI console.',
        },
      ],
      modelIds: ['moonshotai/kimi-k2.5'],
      requiredHosts: ['api.moonshot.ai'],
      policy: {
        lifecycle: 'experimental',
        authorization: 'authorization-pending',
        runnable: false,
        caveats: [
          {
            kind: 'spend',
            severity: 'warning',
            message: 'Usage is metered and may incur direct API charges.',
          },
          {
            kind: 'subscription',
            severity: 'info',
            message:
              'Technically compatible, but Kimi Code membership is the preferred future path.',
          },
        ],
      },
    },
  ],
  models: [
    {
      id: 'opencode/claude-sonnet-4-5',
      providerId: 'opencode-zen',
      displayName: 'Claude Sonnet 4.5',
      lifecycle: 'active',
    },
    {
      id: 'opencode-go/kimi-k2.5',
      providerId: 'opencode-go',
      displayName: 'Kimi K2.5',
      lifecycle: 'active',
    },
    {
      id: 'kimi-coding/k2p5',
      providerId: 'kimi-code',
      displayName: 'Kimi K2.5',
      lifecycle: 'active',
    },
    {
      id: 'moonshotai/kimi-k2.5',
      providerId: 'kimi-api',
      displayName: 'Kimi K2.5',
      lifecycle: 'active',
    },
  ],
} satisfies CompiledProviderManifest;

/** Validated once at module initialization; consumers cannot observe invalid compiled data. */
export const PROVIDER_CATALOG = createProviderCatalog(COMPILED_PROVIDER_MANIFEST);
