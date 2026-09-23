import { randomUUID } from 'node:crypto';
import {
  type AgentRoute,
  type EffectiveLaunchConfig,
  PROVIDER_CATALOG,
  type Pod,
} from '@autopod/shared';
import type { Logger } from 'pino';
import { withAbort } from '../actions/handlers/handler.js';
import { assertLaunchAgentAccount } from '../configuration/agent-route-resolution.js';
import { configurationError } from '../configuration/configuration-store.js';
import type { DockerNetworkManager } from '../containers/docker-network-manager.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ReviewerExecutor } from '../interfaces/reviewer-executor.js';
import type { ProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { persistProviderAccountCredentials } from '../providers/credential-persistence.js';
import { buildProviderAccountEnv } from '../providers/env-builder.js';
import { SYSTEM_CREDENTIAL_SHIM } from '../system-sandbox/runtime-adapters.js';
import { providerRequiredHosts } from '../system-sandbox/system-decision-runner.js';
import {
  ContainerReviewerUnavailableError,
  runContainerReviewer,
} from './container-reviewer-runner.js';
import { CodexReviewError, type CodexReviewTokenUsage } from './review-codex-runner.js';
import { type ReviewerRunRepository, hasMeasuredReviewerUsage } from './reviewer-run-repository.js';

export interface IsolatedReviewerOptions {
  runs: ReviewerRunRepository;
  accounts: ProviderAccountStore;
  logger: Logger;
  manager(target: 'local' | 'sandbox'): ContainerManager;
  /** Trusted daemon-owned image containing only runtime CLIs; never a repository/environment image. */
  image(target: 'local' | 'sandbox'): string | Promise<string>;
  network?: Pick<DockerNetworkManager, 'buildNetworkConfig' | 'removeNetworkForPod'>;
  readPod(podId: string): Pod;
  assertAllowed(config: EffectiveLaunchConfig): Promise<void>;
}

export class IsolatedReviewer {
  constructor(private readonly options: IsolatedReviewerOptions) {}

  executor(
    pod: Pod,
    config: EffectiveLaunchConfig,
    route: AgentRoute,
    purpose: 'review' | 'memory' = 'review',
  ): ReviewerExecutor {
    return async (input) => {
      const requestId = randomUUID();
      const deadline = Date.now() + input.timeout;
      const key = (
        target: Pick<AgentRoute, 'providerAccountId' | 'runtime' | 'model' | 'reasoningEffort'>,
      ) =>
        JSON.stringify([
          target.providerAccountId,
          target.runtime,
          target.model,
          target.reasoningEffort,
        ]);
      const alternatives = route.failover.slice(0, route.maxHops);
      // Follow-main may already point at an alternative. Never return to an earlier target.
      const current = alternatives.findIndex((target) => key(target) === key(route));
      const targets = [route, ...alternatives.slice(current + 1)];
      const visited = new Set<string>();
      let failure: unknown;
      let ordinal = 0;
      for (const target of targets) {
        if (visited.has(key(target))) continue;
        visited.add(key(target));
        const remaining = deadline - Date.now();
        if (ordinal > 0 && remaining <= 0) throw failure;
        try {
          return await this.attemptExecutor(pod, config, { ...route, ...target }, purpose, {
            requestId,
            ordinal,
            deadline,
          })({ ...input, timeout: ordinal === 0 ? input.timeout : remaining });
        } catch (error) {
          failure = error;
          if (
            !(
              error instanceof CodexReviewError ||
              error instanceof ContainerReviewerUnavailableError
            ) ||
            !['authentication-failed', 'provider-unavailable'].includes(error.kind) ||
            !hasMeasuredReviewerUsage(error.tokenUsage)
          )
            throw error;
        }
        ordinal++;
      }
      throw failure;
    };
  }

  private attemptExecutor(
    pod: Pod,
    config: EffectiveLaunchConfig,
    route: AgentRoute,
    purpose: 'review' | 'memory',
    attempt: { requestId: string; ordinal: number; deadline: number },
  ): ReviewerExecutor {
    return async (input) => {
      const deps = this.options;
      if (!['claude', 'codex'].includes(route.runtime))
        configurationError(
          'This runtime has no isolated reviewer adapter',
          'REVIEWER_RUNTIME_UNAVAILABLE',
          409,
        );
      if (
        !Number.isFinite(input.timeout) ||
        input.timeout <= 0 ||
        input.timeout > 3_600_000 ||
        Buffer.byteLength(input.prompt) > 1_000_000
      )
        configurationError('Reviewer input exceeds the execution bounds', 'REVIEWER_INPUT_INVALID');
      const id = `review-${randomUUID()}`;
      const manager = deps.manager(config.execution.target);
      const image = await deps.image(config.execution.target);
      if (!/@sha256:[a-f0-9]{64}$/.test(image))
        configurationError(
          'The isolated reviewer image must be pinned by digest',
          'REVIEWER_IMAGE_UNPINNED',
          503,
        );
      const assertCurrent = () => {
        const current = deps.readPod(pod.id);
        if (
          current.lifecycleGeneration !== pod.lifecycleGeneration ||
          current.launchConfigDigest !== config.digest ||
          !(
            purpose === 'memory'
              ? [
                  'provisioning',
                  'running',
                  'validating',
                  'failed',
                  'review_required',
                  'complete',
                  'killed',
                ]
              : ['running', 'validating']
          ).includes(current.status)
        )
          configurationError(
            'Reviewer no longer owns this pod attempt',
            'REVIEWER_SUPERSEDED',
            409,
          );
        return assertLaunchAgentAccount(
          route,
          config.agentAccounts[route.providerAccountId],
          deps.accounts,
        );
      };
      assertCurrent();
      await withAbort(
        deps.assertAllowed(config),
        AbortSignal.timeout(Math.max(1, attempt.deadline - Date.now())),
      );
      if (Date.now() >= attempt.deadline) throw new Error('Isolated reviewer timed out');
      assertCurrent();
      deps.runs.reserve(id, deps.readPod(pod.id), config, route, attempt);
      let containerId: string | null = null;
      let expired = false;
      let dispatched = false;
      let completed = false;
      let allocationPending = false;
      let networkPending = false;
      let result: Awaited<ReturnType<ReviewerExecutor>> | undefined;
      let failedUsage: CodexReviewTokenUsage | undefined;
      let failureKind: string | undefined;
      const deadline = attempt.deadline;
      const bounded = async <T>(promise: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  expired = true;
                  reject(new Error('Isolated reviewer timed out'));
                },
                Math.max(1, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const guard = () => {
        if (expired || Date.now() >= deadline) throw new Error('Isolated reviewer timed out');
        assertCurrent();
      };
      let watch: ReturnType<typeof setInterval> | undefined;
      try {
        const account = deps.accounts.get(route.providerAccountId);
        const catalog = PROVIDER_CATALOG.providers.find((entry) => entry.id === account.provider);
        if (!catalog)
          configurationError('Reviewer provider is unavailable', 'REVIEWER_PROVIDER_UNAVAILABLE');
        const hosts = providerRequiredHosts(account, catalog.requiredHosts);
        const auth = await bounded(
          buildProviderAccountEnv(route.providerAccountId, deps.logger, {
            providerAccountStore: deps.accounts,
            runtime: route.runtime,
          }),
        );
        guard();
        let network: Awaited<ReturnType<DockerNetworkManager['buildNetworkConfig']>> = null;
        if (config.execution.target === 'local') {
          if (!deps.network)
            configurationError(
              'Reviewer network isolation is unavailable',
              'REVIEWER_NETWORK_UNAVAILABLE',
              503,
            );
          networkPending = true;
          network = await bounded(
            deps.network
              .buildNetworkConfig(
                {
                  enabled: true,
                  mode: 'restricted',
                  allowedHosts: hosts,
                  replaceDefaults: true,
                  allowPackageManagers: false,
                },
                [],
                '127.0.0.1',
                [],
                id,
                [],
                [],
                0,
                false,
              )
              .then(async (created) => {
                networkPending = false;
                if (expired) await deps.network?.removeNetworkForPod(id);
                return created;
              }),
          );
          if (!network)
            configurationError(
              'Reviewer network isolation is unavailable',
              'REVIEWER_NETWORK_UNAVAILABLE',
              503,
            );
        }
        guard();
        allocationPending = true;
        containerId = await bounded(
          manager
            .spawn({
              image,
              podId: id,
              env: {},
              ports: [],
              volumes: [],
              workingDir: '/workspace',
              exposeHostGateway: false,
              networkPolicyMode: 'restricted',
              allowedHosts: hosts,
              networkName: network?.networkName,
              firewallScript: network?.firewallScript,
              memoryBytes: config.resolvedExecution.main.memoryGb * 1024 ** 3,
              ...(config.resolvedExecution.main.cpus !== null
                ? { nanoCpus: config.resolvedExecution.main.cpus * 1e9 }
                : {}),
              onCreated(created) {
                containerId = created;
                deps.runs.attach(id, created);
              },
            })
            .then(async (created) => {
              allocationPending = false;
              if (expired) {
                await manager.kill(created);
                deps.runs.cleaned(id, false);
              }
              return created;
            }),
        );
        guard();
        if (!containerId) throw new Error('Reviewer allocation returned no identity');
        const allocatedContainer = containerId;
        // No workspace, main-account home, tool-pack, MCP, registry or source credentials are copied.
        for (const file of [
          { path: '/run/autopod/agent-shim.sh', content: SYSTEM_CREDENTIAL_SHIM },
          ...auth.containerFiles,
          ...auth.secretFiles,
        ]) {
          await bounded(
            manager.writeFile(allocatedContainer, file.path, file.content, {
              mode: file.path.endsWith('agent-shim.sh') ? 0o500 : 0o600,
            }),
          );
          guard();
        }
        const reviewerContainer = allocatedContainer;
        watch = setInterval(() => {
          try {
            guard();
          } catch {
            expired = true;
            void manager.kill(reviewerContainer).catch(() => deps.runs.cleaned(id, false));
          }
        }, 1000);
        result = await bounded(
          runContainerReviewer({
            podId: pod.id,
            containerId,
            containerManager: manager,
            profile: {
              modelProvider: assertCurrent().adapter,
              providerCredentials: account.credentials,
            },
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            prompt: input.prompt,
            timeout: Math.max(1, deadline - Date.now()),
            outputContract: input.outputContract,
            env: auth.env,
            isolated: true,
            logger: deps.logger,
            beforeLaunch: async () => {
              await deps.assertAllowed(config);
              guard();
              return () => {
                guard();
                deps.runs.running(id);
                dispatched = true;
              };
            },
          }),
        );
        guard();
        await bounded(
          persistProviderAccountCredentials(
            allocatedContainer,
            manager,
            deps.accounts,
            route.providerAccountId,
            deps.logger,
            {
              maxLineage: auth.maxCredentialLineage,
              openAiLineage: auth.requiresOpenAiAuthJsonPersistence
                ? auth.openAiAuthJsonLineage
                : undefined,
              piLineage: auth.requiresPiAuthJsonPersistence ? auth.piAuthJsonLineage : undefined,
            },
          ),
        );
        guard();
        completed = true;
        return result;
      } catch (error) {
        if (
          error instanceof CodexReviewError ||
          error instanceof ContainerReviewerUnavailableError
        ) {
          failedUsage = error.tokenUsage;
          failureKind = error.kind;
        }
        throw error;
      } finally {
        if (watch) clearInterval(watch);
        deps.runs.finish(id, dispatched, completed, result?.tokenUsage ?? failedUsage, failureKind);
        let clean = !allocationPending && !networkPending;
        try {
          if (containerId) await manager.kill(containerId);
        } catch {
          clean = false;
        }
        try {
          if (config.execution.target === 'local') await deps.network?.removeNetworkForPod(id);
        } catch {
          clean = false;
        }
        deps.runs.cleaned(id, clean);
        if (!clean)
          configurationError(
            'Reviewer cleanup requires reconciliation',
            'REVIEWER_CLEANUP_UNCONFIRMED',
            409,
          );
      }
    };
  }

  /** Call only during daemon startup, before accepting launches. Never retry uncertain inference. */
  async recover(): Promise<void> {
    for (const run of this.options.runs.pending()) {
      this.options.runs.interrupt(run.id);
      let clean = true;
      try {
        if (run.container_id)
          await this.options.manager(run.execution_target).kill(run.container_id);
        if (run.execution_target === 'local') {
          if (!this.options.network) throw new Error('Reviewer network cleanup unavailable');
          await this.options.network.removeNetworkForPod(run.id);
        }
      } catch {
        clean = false;
      }
      this.options.runs.cleaned(run.id, clean);
    }
  }
}
