import type { EffectiveLaunchConfig, OperatorActor, Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { assertLaunchAgentAccount } from '../configuration/agent-route-resolution.js';
import { launchPodOptions } from '../configuration/launch-pod-options.js';
import type {
  AdmissionResolvedCaptured,
  AdmissionResolvedLiveDependencies,
} from './admission-contracts.js';
import { admitComposablePod } from './composable-pod-admission.js';
import { prepareIntentionalRerun } from './intentional-rerun-preflight.js';
import type { PodCreator } from './workspace-contracts.js';
export function createAdmissionResolved(
  deps: AdmissionResolvedLiveDependencies,
  captured: AdmissionResolvedCaptured,
) {
  const {
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    assertSandboxAgentStreamingExecSupported,
    podRepo,
    eventBus,
    enqueueSession,
    maybeTriggerDependents,
  } = captured;
  function createResolvedSession(
    config: EffectiveLaunchConfig,
    userId: string,
    creator?: PodCreator,
    actor?: OperatorActor,
    assertRerunSourceQuiescent?: () => string,
  ): Pod {
    if (config.derivation?.kind === 'recovery-fork')
      throw new AutopodError(
        'Recovery forks require operation-owned admission',
        'CONFIG_DERIVATION_INVALID',
        403,
      );
    if (!deps.launchConfiguration)
      throw new AutopodError(
        'Composable launch execution is unavailable',
        'CONFIG_EXECUTION_UNAVAILABLE',
        503,
      );
    if (!providerAccountStore)
      throw new AutopodError(
        'Provider account store is unavailable',
        'PROVIDER_CREDENTIALS_MISSING',
        503,
      );
    assertLaunchAgentAccount(
      config.ai.main,
      config.agentAccounts[config.ai.main.providerAccountId],
      providerAccountStore,
      providerCatalog,
    );
    const options = launchPodOptions(config);
    const backend = containerManagerFactory.get(config.execution.target);
    if (
      options.agentMode === 'interactive' &&
      config.execution.target !== 'local' &&
      !backend.attachTerminal
    )
      throw new AutopodError(
        'Selected backend cannot attach an interactive terminal',
        'INVALID_CONFIGURATION',
        400,
      );
    assertSandboxAgentStreamingExecSupported(
      { name: config.profileId },
      config.execution.target,
      options,
    );
    if (
      options.agentMode !== 'interactive' &&
      config.execution.networkPolicy?.enabled &&
      config.execution.networkPolicy.mode === 'deny-all'
    )
      throw new AutopodError(
        'An agent requires outbound provider access',
        'INVALID_CONFIGURATION',
        400,
      );
    const sidecars = Object.keys(config.resolvedExecution.sidecars);
    if (config.execution.target === 'sandbox' && sidecars.length)
      throw new AutopodError(
        'Sandbox sidecars are unavailable',
        'UNSUPPORTED_SANDBOX_SIDECAR',
        400,
      );
    if (sidecars.some((id) => !config.environment.sidecars.some((sidecar) => sidecar.id === id)))
      throw new AutopodError(
        'Sidecar was not admitted in the launch configuration',
        'INVALID_SIDECAR',
        400,
      );
    if (
      config.intent === 'goal' &&
      (!deps.launchConfiguration.goals || config.ai.main.runtime !== 'codex')
    )
      throw new AutopodError('Native Goal execution is unavailable', 'GOAL_UNAVAILABLE', 503);
    const pod = admitComposablePod({
      config,
      userId,
      creator,
      actor,
      assertRerunSourceQuiescent,
      pods: podRepo,
      read: deps.launchConfiguration.read,
      events: eventBus,
      enqueue: enqueueSession,
      reconcileDependencies: (parentId) => maybeTriggerDependents(podRepo.getOrThrow(parentId)),
    });
    if (config.intent === 'goal') {
      if (!deps.launchConfiguration?.goals)
        throw new AutopodError('Native Goal execution is unavailable', 'GOAL_UNAVAILABLE', 503);
      deps.launchConfiguration.goals.initialize(pod, config);
    }
    return pod;
  }
  async function prepareResolvedSession(
    config: EffectiveLaunchConfig,
    userId: string,
    creator?: PodCreator,
    actor?: OperatorActor,
  ): Promise<() => Pod> {
    if (!config.work.intentionalRerun)
      return () => createResolvedSession(config, userId, creator, actor);
    const assertQuiescent = await prepareIntentionalRerun({
      config,
      userId,
      actor,
      pods: podRepo,
      read: (id) => deps.launchConfiguration?.read(id) ?? null,
      manager: containerManagerFactory.get('local'),
      isIdle: (id) => captured.isRerunSourceIdle?.(id) === true,
    });
    return () => createResolvedSession(config, userId, creator, actor, assertQuiescent);
  }
  return { createResolvedSession, prepareResolvedSession };
}
