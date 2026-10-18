import { createProvisioningAgentMaterials } from './provisioning-agent-materials.js';
import { createProvisioningContainer } from './provisioning-container.js';
import type {
  ProvisioningCaptured,
  ProvisioningInput,
  ProvisioningLiveDependencies,
  ProvisioningResult,
} from './provisioning-ports.js';
import { createProvisioningSessionMaterials } from './provisioning-session-materials.js';
import { createProvisioningWorkspacePopulation } from './provisioning-workspace-population.js';
import { createProvisioningWorkspace } from './provisioning-workspace.js';

type Captured = Pick<
  ProvisioningCaptured,
  | 'materializeSpecFiles'
  | 'captureDeployBaselineHashes'
  | 'podRepo'
  | 'profileStore'
  | 'providerAccountStore'
  | 'providerCatalog'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'logger'
  | 'repoScanner'
  | 'executionCredentialsFor'
  | 'resolveGitCredential'
  | 'assertSandboxAgentStreamingExecSupported'
  | 'destroyPodNetwork'
  | 'stopSandboxPreviewProxy'
  | 'killSidecarsForPod'
  | 'closeProviderAttempt'
  | 'resolveEffectiveBoundProfile'
  | 'openProviderTargetAttempt'
  | 'persistRuntimeCredentialsForPod'
  | 'syncWorkspaceBack'
  | 'transition'
  | 'allocateHostPort'
  | 'CONTAINER_APP_PORT'
  | 'execFileAsync'
  | 'networkManager'
  | 'sidecarManager'
  | 'mcpBaseUrl'
  | 'injectionsForPod'
  | 'startHaproxyDenyReceiver'
  | 'hostnameFromUrl'
  | 'portFromUrl'
  | 'buildPrFixTask'
  | 'fixFeedbackRepo'
  | 'escalationRepo'
  | 'validationRepo'
  | 'progressEventRepo'
  | 'safetyEventsRepo'
  | 'rememberMaxCredentialLineage'
  | 'emitActivityStatus'
>;

export function createProvisioningWorkflow(deps: ProvisioningLiveDependencies, captured: Captured) {
  const {
    materializeSpecFiles,
    captureDeployBaselineHashes,
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    worktreeManager,
    logger,
    repoScanner,
    executionCredentialsFor,
    resolveGitCredential,
    assertSandboxAgentStreamingExecSupported,
    destroyPodNetwork,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    closeProviderAttempt,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    persistRuntimeCredentialsForPod,
    syncWorkspaceBack,
    transition,
    allocateHostPort,
    CONTAINER_APP_PORT,
    execFileAsync,
    networkManager,
    sidecarManager,
    mcpBaseUrl,
    injectionsForPod,
    startHaproxyDenyReceiver,
    hostnameFromUrl,
    portFromUrl,
    buildPrFixTask,
    fixFeedbackRepo,
    escalationRepo,
    validationRepo,
    progressEventRepo,
    safetyEventsRepo,
    rememberMaxCredentialLineage,
    emitActivityStatus,
  } = captured;
  const workspace = createProvisioningWorkspace(deps, {
    materializeSpecFiles,
    captureDeployBaselineHashes,
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    worktreeManager,
    logger,
    repoScanner,
    executionCredentialsFor,
    resolveGitCredential,
    assertSandboxAgentStreamingExecSupported,
    destroyPodNetwork,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    closeProviderAttempt,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    persistRuntimeCredentialsForPod,
    syncWorkspaceBack,
    transition,
  });
  const container = createProvisioningContainer(deps, {
    allocateHostPort,
    CONTAINER_APP_PORT,
    execFileAsync,
    podRepo,
    profileStore,
    containerManagerFactory,
    worktreeManager,
    networkManager,
    sidecarManager,
    mcpBaseUrl,
    logger,
    executionCredentialsFor,
    injectionsForPod,
    startHaproxyDenyReceiver,
    hostnameFromUrl,
    portFromUrl,
  });
  const population = createProvisioningWorkspacePopulation(deps, {
    buildPrFixTask,
    podRepo,
    fixFeedbackRepo,
    logger,
    transition,
  });
  const materials = createProvisioningSessionMaterials(deps, {
    podRepo,
    escalationRepo,
    mcpBaseUrl,
    logger,
    validationRepo,
    progressEventRepo,
    safetyEventsRepo,
    injectionsForPod,
  });
  const agent = createProvisioningAgentMaterials(deps, {
    profileStore,
    providerAccountStore,
    providerCatalog,
    mcpBaseUrl,
    logger,
    safetyEventsRepo,
    injectionsForPod,
    rememberMaxCredentialLineage,
    emitActivityStatus,
  });
  async function preparePodExecution(input: ProvisioningInput): Promise<ProvisioningResult> {
    const workspaceResult = await workspace.prepareWorkspace(input);
    if (workspaceResult.kind === 'halted') return workspaceResult;
    const containerResult = await container.prepareContainer(workspaceResult);
    const populationResult = await population.populateWorkspace(containerResult);
    const materialsResult = await materials.prepareSessionMaterials(populationResult);
    if (materialsResult.kind === 'halted') return materialsResult;
    const prepared = await agent.prepareAgentMaterials(materialsResult);
    return { kind: 'ready', prepared };
  }
  return { preparePodExecution };
}
