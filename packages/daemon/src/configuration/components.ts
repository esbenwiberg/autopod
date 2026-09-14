import type { AgentRoute, EffectiveLaunchConfig, ScheduledJob } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import { createDeploymentRunRepository } from '../actions/deployment-run-repository.js';
import {
  type DeploymentServiceOptions,
  createDeploymentService,
} from '../actions/deployment-service.js';
import type { ServiceReadTransport } from '../actions/service-read-broker.js';
import type { ConfigurationRouteDependencies } from '../api/routes/configuration.js';
import { atomicPodChange } from '../db/unit-of-work.js';
import { GitHubDiscovery } from '../github/discovery.js';
import type { GitHubMutationClient } from '../github/mutation-broker.js';
import type { GitHubDownloadClient } from '../github/read-broker.js';
import type { ImageBuilder } from '../images/image-builder.js';
import { createWatcherBindingRepository } from '../issue-watcher/watcher-binding-repository.js';
import { createPimActivationRepository } from '../pim/activation-repository.js';
import type { PimActivationProvider } from '../pim/activation-service.js';
import { createPimActivationService } from '../pim/activation-service.js';
import type { PimEligibilityService } from '../pim/eligibility-service.js';
import { createPimPodLifecycle } from '../pim/pod-lifecycle.js';
import { createPodGoalService } from '../pods/pod-goal-service.js';
import type { PodManager, PodManagerDependencies } from '../pods/pod-manager.js';
import type { PodRepository } from '../pods/pod-repository.js';
import type { ProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { IsolatedReviewer, type IsolatedReviewerOptions } from '../validation/isolated-reviewer.js';
import { ReviewerRunRepository } from '../validation/reviewer-run-repository.js';
import { assertLaunchAgentAccount, resolveLaunchAgentRoute } from './agent-route-resolution.js';
import { assertAnalysisWorkspace } from './analysis-workspace.js';
import { configurationError, createConfigurationStore } from './configuration-store.js';
import { resolveLaunchCredentialReferences } from './credential-references.js';
import type { ConfigurationCredentialStore } from './credential-store.js';
import { deriveLaunch } from './derive-launch.js';
import { createLaunchExecutionCredentials } from './execution-credentials.js';
import { admitLaunch } from './launch-admission.js';
import { resolveLaunchExecutionSettings } from './launch-execution-settings.js';
import { type LaunchResolutionServices, configurationDigest } from './launch-resolver.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';
import { resolveExecution } from './resolve-execution.js';
import { createScanLaunches } from './scan-launches.js';
import { createScopedPodTools } from './scoped-pod-tools.js';
import { ConfigurationSecurityPolicyStore } from './security-policy.js';
import { createSeriesLaunches } from './series-launches.js';
import { createWatcherLaunches } from './watcher-launches.js';

export interface ConfigurationComponentsOptions {
  db: Database.Database;
  logger: Logger;
  pods: PodRepository;
  accounts: ProviderAccountStore;
  credentials: ConfigurationCredentialStore;
  images: Pick<ImageBuilder, 'resolveEnvironment' | 'buildEnvironmentImage'>;
  github: GitHubMutationClient & GitHubDownloadClient;
  audit: ActionAuditRepository;
  serviceReadTransport?: ServiceReadTransport;
  deployment?: Pick<
    DeploymentServiceOptions,
    'target' | 'publishedDefault' | 'archive' | 'run' | 'stop'
  >;
  pim?: { eligibility: PimEligibilityService; provider: PimActivationProvider };
  reviewer: Pick<IsolatedReviewerOptions, 'manager' | 'image' | 'network'>;
  ports: Pick<
    LaunchResolutionServices,
    'referenceRevision' | 'skillContent' | 'executionCapabilities' | 'assertCapabilities'
  >;
  /** Closed until the explicit migration/caller cutover is complete. */
  admissionReady(): { ready: boolean; reason?: string };
  /** Exact provider/backend/image acceptance receipts, supplied by the daemon operator only. */
  nativeGoalEvidence?: readonly unknown[];
  /** Bound after constructing PodManager, before admitting or recovering any launch. */
  podManager(): PodManager;
}

/** The daemon composition shares one frozen resolver and one current operator ceiling everywhere. */
export function createConfigurationComponents(options: ConfigurationComponentsOptions) {
  const { db } = options;
  const store = createConfigurationStore(db);
  const watchers = createWatcherBindingRepository(db);
  const snapshots = createLaunchSnapshotRepository(db, store);
  const policy = new ConfigurationSecurityPolicyStore(db);
  const executionCredentials = createLaunchExecutionCredentials(options.credentials);
  const deployments = options.deployment
    ? createDeploymentService({
        ...options.deployment,
        runs: createDeploymentRunRepository(db),
        context(podId) {
          const pod = options.pods.getOrThrow(podId);
          const config = snapshots.get(podId);
          if (pod.status !== 'running' || !config || config.digest !== pod.launchConfigDigest)
            configurationError(
              'Deployment requires the original running pod',
              'DEPLOYMENT_POD_UNAVAILABLE',
              409,
            );
          return { config, ownerId: pod.userId };
        },
        assertCurrent(config) {
          policy.assertLaunch(config);
          if (
            configurationDigest(resolveLaunchCredentialReferences(config, options.credentials)) !==
            configurationDigest(config.credentialReferences)
          )
            configurationError(
              'Deployment credential authority changed',
              'CONFIG_CREDENTIAL_CHANGED',
              403,
            );
        },
        async credentials(config) {
          return (await executionCredentials.deployment(config))?.env ?? {};
        },
        credentialRevisions(config) {
          const references = Object.values(
            config.repository?.setup.integrations.deployment?.env ?? {},
          ).flatMap((value) => ('secretId' in value ? [value.secretId] : []));
          return Object.fromEntries(
            references.map((id) => [id, options.credentials.get(id).revision]),
          );
        },
      })
    : undefined;
  const github = new GitHubDiscovery(options.github);
  const pimRepository = createPimActivationRepository(db);
  const activation = options.pim
    ? createPimActivationService(pimRepository, options.pim.eligibility, options.pim.provider)
    : undefined;
  const assertPimAllowed = (selection: Parameters<typeof policy.assertPimAllowed>[0]) =>
    policy.assertPimAllowed(selection);
  async function assertCurrent(config: EffectiveLaunchConfig) {
    policy.assertLaunch(config);
    if (config.repository?.setup.integrations.deployment?.enabled) {
      if (!deployments)
        configurationError(
          'Deployment runner is unavailable',
          'DEPLOYMENT_ISOLATION_UNAVAILABLE',
          503,
        );
      deployments.assertAvailable(config);
    }
    if (config.repository?.setup.integrations.serviceAccess.length && !options.serviceReadTransport)
      configurationError(
        'Scoped service read transport is unavailable',
        'SERVICE_READ_UNAVAILABLE',
        503,
      );
    const checkRoute = (route: AgentRoute) => {
      for (const selected of [route, ...route.failover])
        assertLaunchAgentAccount(
          { ...selected, failover: [], maxHops: 0 },
          config.agentAccounts[selected.providerAccountId],
          options.accounts,
        );
    };
    checkRoute(config.ai.main);
    if (config.ai.reviewer.mode === 'independent') checkRoute(config.ai.reviewer.route);
    const currentReferences = resolveLaunchCredentialReferences(config, options.credentials);
    if (configurationDigest(currentReferences) !== configurationDigest(config.credentialReferences))
      configurationError(
        'Service credential identity or scope changed after admission',
        'CONFIG_CREDENTIAL_CHANGED',
        403,
      );
    const allocation = resolveExecution({
      environment: config.environment,
      execution: {
        ...config.execution,
        main: config.resolvedExecution.main,
        sidecars: config.resolvedExecution.sidecars,
      },
      requiredSidecarIds: config.requiredSidecarIds,
      trustedRepository: !!config.repository?.config.trustedSetupIds.includes(
        config.repository.setup.id,
      ),
      capabilities: await options.ports.executionCapabilities(config.execution.target),
    });
    if (configurationDigest(allocation) !== configurationDigest(config.resolvedExecution))
      configurationError(
        'The backend can no longer provide the frozen allocation',
        'EXECUTION_CAPABILITIES_CHANGED',
        409,
      );
    for (const selection of config.pim) {
      if (!options.pim)
        configurationError('PIM user account is not configured', 'PIM_ACCOUNT_UNAVAILABLE', 503);
      await options.pim.eligibility.selected(selection);
    }
    assertAnalysisWorkspace(config);
    await options.ports.assertCapabilities(config);
    policy.assertLaunch(config);
  }
  const resolution: LaunchResolutionServices = {
    ...options.ports,
    deploymentAvailable: !!deployments,
    readLaunch: snapshots.get,
    store,
    resolveEnvironment: (environment, target) =>
      options.images.resolveEnvironment(environment, target),
    githubRepositories: (rule, repository) => github.resolveRepositories(rule, repository),
    githubWorkflows: (rule) => github.resolveWorkflows(rule),
    resolveAgentRoute: async (route) => resolveLaunchAgentRoute(route, options.accounts),
    resolveCredentialReferences: async (config) =>
      resolveLaunchCredentialReferences(config, options.credentials),
    assertCapabilities: assertCurrent,
  };
  const reviewer = new IsolatedReviewer({
    ...options.reviewer,
    runs: new ReviewerRunRepository(db, (id) => {
      if (!options.pods.taskExecutions)
        configurationError('Whole-task accounting is unavailable', 'TASK_BUDGET_UNAVAILABLE', 503);
      return options.pods.taskExecutions.snapshot(id);
    }),
    accounts: options.accounts,
    logger: options.logger,
    readPod: (id) => options.pods.getOrThrow(id),
    assertAllowed: assertCurrent,
  });
  const scopedTools = createScopedPodTools({
    db,
    deployments,
    snapshots,
    pods: options.pods,
    github: options.github,
    audit: options.audit,
    serviceReads: options.serviceReadTransport
      ? {
          transport: options.serviceReadTransport,
          assertAllowed: (config) => policy.assertLaunch(config),
        }
      : undefined,
    githubCeiling: async (config) => policy.githubCeiling(config),
    assertPimAllowed,
    pim:
      options.pim && activation ? { eligibility: options.pim.eligibility, activation } : undefined,
  });
  const goals = createPodGoalService({
    db,
    pods: options.pods,
    recovery: { readConfig: snapshots.get, manager: options.reviewer.manager('local') },
    evidence: options.nativeGoalEvidence ?? [],
    assertAllowed: assertCurrent,
    assertCurrent(config) {
      policy.assertLaunch(config);
      for (const route of [config.ai.main, ...config.ai.main.failover])
        assertLaunchAgentAccount(
          { ...route, failover: [], maxHops: 0 },
          config.agentAccounts[route.providerAccountId],
          options.accounts,
        );
    },
    publish(goal) {
      options.logger.info(
        { podId: goal.podId, state: goal.state, tokens: goal.observedTokens },
        'Native Goal state observed',
      );
    },
  });
  const launchConfiguration: NonNullable<PodManagerDependencies['launchConfiguration']> = {
    goals,
    read: snapshots.get,
    executionSettings: (config) =>
      resolveLaunchExecutionSettings(config, { image: config.resolvedEnvironment.pinnedBase }),
    assertCurrentCapabilities: assertCurrent,
    async beginGoalRework(podId, task, apply) {
      const owner = options.pods.getOrThrow(podId);
      const parent = snapshots.get(podId);
      if (!parent) configurationError('Goal launch is unavailable', 'CONFIG_SOURCE_MISSING', 409);
      const config = deriveLaunch(parent, {
        source: { podId, digest: parent.digest, kind: 'goal-rework' },
        task,
      });
      await assertCurrent(config);
      atomicPodChange(options.pods, () =>
        snapshots.activateGoalRework({
          config,
          expectedGeneration: owner.lifecycleGeneration,
          apply: () => apply(config),
        }),
      );
    },
    async prepareWorker(input, apply) {
      const owner = options.pods.getOrThrow(input.source.podId);
      const parent = snapshots.get(owner.id);
      if (!parent)
        configurationError('Workspace launch is unavailable', 'CONFIG_SOURCE_MISSING', 409);
      const config = deriveLaunch(parent, input);
      await assertCurrent(config);
      atomicPodChange(options.pods, () =>
        snapshots.prepareWorker({
          config,
          expectedGeneration: owner.lifecycleGeneration,
          apply: () => apply(config),
        }),
      );
    },
    async activateWorker(podId, generation, apply) {
      const config = snapshots.getPendingWorker(podId);
      if (!config) return false;
      await assertCurrent(config);
      return atomicPodChange(options.pods, () =>
        snapshots.activateWorker(podId, generation, apply),
      );
    },
    async admitDerived(input, createPod) {
      const owner = options.pods.getOrThrow(input.source.podId);
      const parent = snapshots.get(input.source.podId);
      if (!parent)
        configurationError('Derived launch source is unavailable', 'CONFIG_SOURCE_MISSING', 409);
      const config = deriveLaunch(parent, input);
      await assertCurrent(config);
      const currentOwner = options.pods.getOrThrow(input.source.podId);
      if (
        owner.lifecycleGeneration !== currentOwner.lifecycleGeneration ||
        owner.status !== currentOwner.status ||
        currentOwner.launchConfigDigest !== parent.digest
      )
        configurationError(
          'Derived launch parent changed during preflight',
          'CONFIG_SOURCE_CHANGED',
          409,
        );
      const requestId = `derived-${configurationDigest(input)}`;
      return snapshots.admit({
        config,
        requestId,
        requestDigest: configurationDigest({ source: input.source, config: config.digest }),
        createPod: () => createPod(config),
      }).podId;
    },
    async prepareEnvironment(config) {
      await assertCurrent(config);
      const built = await options.images.buildEnvironmentImage(
        { environment: config.environment, ...config.resolvedEnvironment },
        { publish: config.execution.target === 'sandbox' },
      );
      await assertCurrent(config);
      return built.tag;
    },
    credentials: createLaunchExecutionCredentials(options.credentials),
    pim: activation
      ? createPimPodLifecycle({
          readPod: (id) => options.pods.getOrThrow(id),
          readSnapshot: snapshots.get,
          assertAllowed: assertPimAllowed,
          activation,
          repository: pimRepository,
        })
      : undefined,
    reviewer,
  };
  const routes: ConfigurationRouteDependencies = {
    deployments,
    series: createSeriesLaunches({
      db,
      resolution,
      snapshots,
      ready: () => options.admissionReady().ready && !policy.get().payload.suspended,
      read: (id) => options.pods.getForHistory?.(id) ?? options.pods.getOrThrow(id),
      create(config, owner) {
        const manager = options.podManager();
        if (!manager.createResolvedSession)
          configurationError(
            'Composable execution is unavailable',
            'CONFIG_EXECUTION_UNAVAILABLE',
            503,
          );
        return manager.createResolvedSession(config, owner);
      },
    }),
    watchers,
    goals: {
      get: goals.get,
      async control(podId, intent, revision) {
        const goal = goals.get(podId);
        if (!goal || goal.revision !== revision)
          configurationError('Goal changed before control', 'GOAL_CHANGED', 409);
        const manager = options.podManager();
        if (intent === 'pause') await manager.pauseSession(podId);
        else await manager.killSession(podId);
        const current = goals.get(podId);
        if (!current) configurationError('Pod Goal is unavailable', 'GOAL_NOT_FOUND', 404);
        return current;
      },
      resume: (podId, revision) => {
        const manager = options.podManager();
        if (!manager.resumeNativeGoal)
          configurationError('Native Goal resume is unavailable', 'GOAL_UNAVAILABLE', 503);
        return manager.resumeNativeGoal(podId, revision);
      },
    },
    db,
    resolution,
    credentials: options.credentials,
    githubDiscovery: github,
    securityPolicy: policy,
    capabilities: async () => {
      const ready = options.admissionReady();
      const suspended = policy.get().payload.suspended;
      return {
        schemaVersion: 1,
        launchAvailable: ready.ready && !suspended,
        launchUnavailableReason: suspended
          ? 'Execution is suspended by the operator'
          : ready.reason,
        execution: await Promise.all(
          (['local', 'sandbox'] as const).map(options.ports.executionCapabilities),
        ),
        nativeGoals: [],
        deployment: { available: !!deployments, source: 'published-default', backend: 'local' },
      };
    },
    async admit(request, identity) {
      const ready = options.admissionReady();
      if (!ready.ready)
        configurationError(
          ready.reason ?? 'Configuration cutover is incomplete',
          'CONFIG_CUTOVER_REQUIRED',
          409,
        );
      const manager = options.podManager();
      if (!manager.createResolvedSession)
        configurationError(
          'Composable pod execution is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      const createSession = manager.createResolvedSession.bind(manager);
      const admitted = await admitLaunch({
        request,
        actorId: identity.userId,
        services: resolution,
        snapshots,
        createPod: (config) =>
          createSession(
            config,
            identity.userId,
            { name: identity.name, email: identity.email },
            identity.actor,
          ).id,
      });
      return options.pods.getOrThrow(admitted.podId);
    },
  };
  return {
    scanLaunches: createScanLaunches({
      db,
      resolution,
      snapshots,
      pods: options.pods,
      ready: () => options.admissionReady().ready && !policy.get().payload.suspended,
      create(config, ownerUserId) {
        const manager = options.podManager();
        if (!manager.createResolvedSession)
          configurationError(
            'Composable execution unavailable',
            'CONFIG_EXECUTION_UNAVAILABLE',
            503,
          );
        return manager.createResolvedSession(config, ownerUserId, undefined, {
          type: 'human',
          userId: ownerUserId,
        });
      },
    }),
    watcherLaunches: createWatcherLaunches({
      bindings: watchers,
      store,
      snapshots,
      pods: options.pods,
      resolution,
      ready: () => options.admissionReady().ready && !policy.get().payload.suspended,
      create(config, ownerUserId) {
        const manager = options.podManager();
        if (!manager.createResolvedSession)
          configurationError(
            'Composable execution is unavailable',
            'CONFIG_EXECUTION_UNAVAILABLE',
            503,
          );
        return manager.createResolvedSession(config, ownerUserId);
      },
    }),
    store,
    snapshots,
    policy,
    resolution,
    routes,
    launchConfiguration,
    scopedTools,
    async launchScheduled(job: ScheduledJob, task: string, runKey: string) {
      if (!job.launch || !job.ownerUserId || job.scan)
        configurationError(
          'Scheduled launch binding is incomplete',
          'SCHEDULE_CONVERSION_REQUIRED',
          409,
        );
      const ready = options.admissionReady();
      if (!ready.ready)
        configurationError(
          ready.reason ?? 'Configuration cutover is incomplete',
          'CONFIG_CUTOVER_REQUIRED',
          409,
        );
      const manager = options.podManager();
      if (!manager.createResolvedSession)
        configurationError(
          'Composable execution is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      const create = manager.createResolvedSession.bind(manager);
      const ownerUserId = job.ownerUserId;
      const admitted = await admitLaunch({
        request: {
          ...job.launch,
          task,
          requestId: `schedule-${configurationDigest({ jobId: job.id, runKey })}`,
        },
        actorId: job.ownerUserId,
        origin: { kind: 'schedule', jobId: job.id, runKey },
        services: resolution,
        snapshots,
        createPod: (config) => {
          const current = db
            .prepare('SELECT launch_selection,owner_user_id,enabled FROM scheduled_jobs WHERE id=?')
            .get(job.id) as
            | { launch_selection: string | null; owner_user_id: string | null; enabled: number }
            | undefined;
          if (
            !current?.launch_selection ||
            current.owner_user_id !== ownerUserId ||
            configurationDigest(JSON.parse(current.launch_selection)) !==
              configurationDigest(job.launch) ||
            (!current.enabled && runKey.startsWith('scheduled:'))
          )
            configurationError(
              'Schedule changed during launch resolution',
              'SCHEDULE_CHANGED',
              409,
            );
          return create(config, ownerUserId).id;
        },
      });
      return options.pods.getOrThrow(admitted.podId);
    },
    async recover() {
      scopedTools.recoverInterrupted();
      createDeploymentRunRepository(db).recoverInterrupted();
      await deployments?.recover();
      pimRepository.recoverInterrupted();
      await reviewer.recover();
      const interruptedGoals = db
        .prepare(`SELECT g.pod_id FROM pod_goals g WHERE g.execution_stopped=0 OR EXISTS(
          SELECT 1 FROM task_agent_runs r WHERE r.id=g.attempt_id AND r.pod_id=g.pod_id
          AND r.generation=g.generation AND r.ended_at IS NULL)`)
        .all() as { pod_id: string }[];
      for (const { pod_id: podId } of interruptedGoals) {
        try {
          await goals.recover(podId);
        } catch {
          options.logger.warn(
            { podId },
            'Native Goal recovery remains unconfirmed; continuation is blocked',
          );
        }
      }
    },
  };
}
