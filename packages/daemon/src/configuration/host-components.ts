import type { EffectiveLaunchConfig } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import { z } from 'zod';
import { createDeploymentHostAdapter } from '../actions/deployment-host-adapter.js';
import { deploymentTargetSchema } from '../actions/deployment-service.js';
import { createServiceReadTransport } from '../actions/service-read-transport.js';
import type { CredentialsCipher } from '../crypto/credentials-cipher.js';
import { createGitHubApiClient } from '../github/api-client.js';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import { createGitHubDownloadClient } from '../github/download-client.js';
import { createPimAccountCredential } from '../pim/account-credential.js';
import { createPimActivationProvider } from '../pim/activation-provider.js';
import { createPimApiClient } from '../pim/api-client.js';
import { createPimEligibilityService } from '../pim/eligibility-service.js';
import { createPimPolicyReader } from '../pim/policy-reader.js';
import type { AzureDevOpsAuth } from '../providers/azure-devops-auth.js';
import { getAzureToken } from '../providers/azure-token.js';
import { dockerCapabilities, sandboxCapabilities } from './backend-capabilities.js';
import {
  type ConfigurationComponentsOptions,
  createConfigurationComponents,
} from './components.js';
import { configurationError, createConfigurationStore } from './configuration-store.js';
import { createConfigurationCredentialStore } from './credential-store.js';
import { createServiceCredentialBoundary } from './service-credential-boundary.js';
import { createConfigurationSourceReaders } from './source-readers.js';

const PINNED_REVIEWER_IMAGE = /@sha256:[a-f0-9]{64}$/;
const REVIEWER_IMAGE_CACHE_MS = 10 * 60_000;

export const hostConfigurationSettingsSchema = z
  .object({
    deploymentTargets: z
      .array(deploymentTargetSchema)
      .refine((v) => new Set(v.map((t) => t.id)).size === v.length, 'Duplicate deployment targets')
      .default([]),
    skillRoots: z.array(z.string().min(1)).default([]),
    pimAccount: z
      .object({ tenantId: z.string().uuid(), principalId: z.string().uuid() })
      .strict()
      .nullable()
      .default(null),
    reviewerImages: z
      .object({
        local: z
          .string()
          .regex(/@sha256:[a-f0-9]{64}$/)
          .optional(),
        sandbox: z
          .string()
          .regex(/@sha256:[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .default({}),
    docker: z
      .object({
        privilegedSidecars: z.boolean().default(false),
        limits: z
          .object({ memoryGb: z.number().positive(), cpus: z.number().positive() })
          .strict()
          .default({ memoryGb: 128, cpus: 128 }),
        defaults: z
          .object({ memoryGb: z.number().positive(), cpus: z.number().positive() })
          .strict()
          .default({ memoryGb: 2, cpus: 1 }),
      })
      .strict()
      .default({}),
  })
  .strict();

type ReviewerTarget = 'local' | 'sandbox';

/**
 * Configured images win. Otherwise a registry fallback is resolved and re-resolved periodically so a
 * republished image is picked up; failures are not cached, so a registry outage only affects the
 * launches that hit it.
 */
export function createReviewerImageSelector(input: {
  configured: Partial<Record<ReviewerTarget, string>>;
  fallback?: ((target: ReviewerTarget) => Promise<string>) | undefined;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const cache = new Map<ReviewerTarget, { image: string; expiresAt: number }>();
  return async (target: ReviewerTarget): Promise<string> => {
    const configured = input.configured[target];
    if (configured) return configured;
    const cached = cache.get(target);
    if (cached && cached.expiresAt > now()) return cached.image;
    let resolved: string | null = null;
    if (input.fallback) {
      try {
        resolved = await input.fallback(target);
      } catch (err) {
        input.logger.warn({ err, target }, 'Default reviewer image resolution failed');
      }
    }
    if (!resolved || !PINNED_REVIEWER_IMAGE.test(resolved))
      configurationError(
        'Configure a pinned isolated reviewer image for this backend',
        'REVIEWER_IMAGE_UNAVAILABLE',
        503,
      );
    cache.set(target, { image: resolved, expiresAt: now() + REVIEWER_IMAGE_CACHE_MS });
    return resolved;
  };
}

/** Real host composition. Library editing is available while execution remains cutover-gated. */
export function createHostConfigurationComponents(
  options: Pick<
    ConfigurationComponentsOptions,
    'db' | 'logger' | 'pods' | 'accounts' | 'audit' | 'podManager' | 'admissionReady'
  > & {
    cipher: CredentialsCipher;
    githubAuth: DaemonGitHubAuth;
    azureDevOpsAuth: AzureDevOpsAuth;
    images?: ConfigurationComponentsOptions['images'];
    reviewerManager: ConfigurationComponentsOptions['reviewer']['manager'];
    network?: ConfigurationComponentsOptions['reviewer']['network'];
    docker?: Dockerode;
    readSnapshotArchive?: (input: { repoUrl: string; revision: string }) => Promise<Buffer>;
    sandboxEnabled: boolean;
    sandboxDefaultTier: 'XS' | 'S' | 'M' | 'L';
    settings: z.infer<typeof hostConfigurationSettingsSchema>;
    /** Registry-pinned fallback used when settings name no reviewer image for a target. */
    defaultReviewerImage?: (target: 'local' | 'sandbox') => Promise<string>;
  },
) {
  const { settings, readSnapshotArchive } = options;
  const store = createConfigurationStore(options.db);
  const github = {
    ...createGitHubApiClient(options.githubAuth),
    ...createGitHubDownloadClient(options.githubAuth),
  };
  const sources = createConfigurationSourceReaders({
    store,
    github,
    skillRoots: settings.skillRoots,
  });
  const pimClient = settings.pimAccount
    ? createPimApiClient(
        settings.pimAccount,
        createPimAccountCredential(settings.pimAccount, options.logger),
      )
    : undefined;
  const credentials = createConfigurationCredentialStore(
    options.db,
    options.cipher,
    createServiceCredentialBoundary(async () => {
      const providers = new Set(store.list('repository').map((entry) => entry.payload.provider));
      const protectedValues: string[] = [];
      if (providers.has('github'))
        protectedValues.push((await options.githubAuth.resolveCredential()).token);
      if (providers.has('ado')) protectedValues.push(await options.azureDevOpsAuth.getToken());
      return protectedValues;
    }),
  );
  const image = createReviewerImageSelector({
    configured: settings.reviewerImages,
    fallback: options.defaultReviewerImage,
    logger: options.logger,
  });
  const requireImages = () => {
    if (!options.images)
      configurationError(
        'Environment image building is unavailable on this daemon',
        'ENVIRONMENT_BUILDER_UNAVAILABLE',
        503,
      );
    return options.images;
  };
  return createConfigurationComponents({
    ...options,
    deployment:
      options.docker && readSnapshotArchive
        ? {
            ...createDeploymentHostAdapter({
              docker: options.docker,
              network: options.network,
              logger: options.logger,
              targets: settings.deploymentTargets,
            }),
            publishedDefault: sources.publishedDefault,
            archive: (repository, commit) =>
              readSnapshotArchive({ repoUrl: repository.remote, revision: commit }),
          }
        : undefined,
    credentials,
    serviceReadTransport: createServiceReadTransport({
      ado: () => options.azureDevOpsAuth.getToken(),
      logs: async () =>
        (await getAzureToken('https://api.loganalytics.io/.default', options.logger)).token,
    }),
    github,
    images: {
      resolveEnvironment: (environment, target) =>
        requireImages().resolveEnvironment(environment, target),
      buildEnvironmentImage: (input, buildOptions) =>
        requireImages().buildEnvironmentImage(input, buildOptions),
    },
    pim: pimClient
      ? {
          eligibility: createPimEligibilityService(pimClient, createPimPolicyReader(pimClient)),
          provider: createPimActivationProvider(pimClient),
        }
      : undefined,
    reviewer: { manager: options.reviewerManager, image, network: options.network },
    ports: {
      ...sources,
      executionCapabilities: (target) =>
        target === 'local'
          ? dockerCapabilities({ docker: options.docker ?? null, ...settings.docker })
          : Promise.resolve(
              sandboxCapabilities({
                enabled: options.sandboxEnabled,
                defaultTier: options.sandboxDefaultTier,
              }),
            ),
      async assertCapabilities(config: EffectiveLaunchConfig) {
        if (config.intent === 'goal')
          configurationError(
            'Native Goal provider and recovery acceptance is not enabled',
            'GOAL_UNAVAILABLE',
            409,
          );
        const routes = [
          config.ai.main,
          ...config.ai.main.failover,
          ...(config.ai.reviewer.mode === 'independent'
            ? [config.ai.reviewer.route, ...config.ai.reviewer.route.failover]
            : []),
        ];
        for (const route of routes) {
          if (config.agentAccounts[route.providerAccountId]?.providerId === 'copilot')
            configurationError(
              'Copilot requires a source-isolated authentication adapter',
              'PROVIDER_SOURCE_CREDENTIAL_UNSAFE',
              409,
            );
        }
        if (
          config.workflow.validationPhases.includes('review') ||
          config.workflow.advisoryBrowserQaEnabled
        )
          await image(config.execution.target);
      },
    },
  });
}
