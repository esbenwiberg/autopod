import type { EffectiveLaunchConfig, SystemEvent } from '@autopod/shared';
import { afterEach, vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { resolveLaunchExecutionSettings } from '../configuration/launch-execution-settings.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createAdmissionAnalysisWorkspaces } from '../pods/admission-analysis-workspaces.js';
import type {
  AdmissionAnalysisLiveDependencies,
  AdmissionExecutionLiveDependencies,
  AdmissionQueriesLiveDependencies,
  AdmissionResolvedLiveDependencies,
} from '../pods/admission-contracts.js';
import { createAdmissionDependents } from '../pods/admission-dependents.js';
import { createAdmissionExecutionContext } from '../pods/admission-execution-context.js';
import { createAdmissionLegacy } from '../pods/admission-legacy.js';
import { createAdmissionQueries } from '../pods/admission-queries.js';
import { createAdmissionResolved } from '../pods/admission-resolved.js';
import { createAdmissionSeriesDeletion } from '../pods/admission-series-deletion.js';
import { createMemoryRepository } from '../pods/memory-repository.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { createTestConfiguration } from './configuration-helpers.js';
import { createProvisioningFixture } from './provisioning-helpers.js';
export { deferred } from './resource-helpers.js';
export const flushAdmission = () => new Promise<void>((resolve) => setImmediate(resolve));
const closes: Array<() => void> = [];
afterEach(async () => {
  await flushAdmission();
  for (const close of closes.splice(0).reverse()) close();
});
export function createAdmissionFixture(disk = false) {
  const f = createProvisioningFixture(disk);
  closes.push(f.close);
  const enqueueSession = vi.fn<(id: string) => void>();
  const events: SystemEvent[] = [];
  f.deps.eventBus.subscribe((e) => events.push(e));
  const memoryRepo = createMemoryRepository(f.db);
  const live: AdmissionExecutionLiveDependencies &
    AdmissionResolvedLiveDependencies &
    AdmissionQueriesLiveDependencies &
    AdmissionAnalysisLiveDependencies = { memoryRepo };
  const context = createAdmissionExecutionContext(live, {
    profileStore: f.profiles,
    daemonConfig: f.deps.daemonConfig,
  });
  const captured = {
    podRepo: f.podRepo,
    logger: f.deps.logger,
    eventBus: f.deps.eventBus,
    enqueueSession,
    profileStore: f.profiles,
    providerAccountStore: f.accounts,
    providerCatalog: undefined,
    containerManagerFactory: f.deps.containerManagerFactory,
    assertSandboxAgentStreamingExecSupported: f.sandbox.assertSandboxAgentStreamingExecSupported,
    ...context,
    validationRepo: f.deps.validationRepo,
  };
  const dependents = createAdmissionDependents(captured);
  const resolved = () => createAdmissionResolved(live, { ...captured, ...dependents });
  async function native() {
    const { store, services } = createTestConfiguration(f.db);
    services.resolveAgentRoute = vi.fn(async (route) => resolveLaunchAgentRoute(route, f.accounts));
    const snapshots = createLaunchSnapshotRepository(f.db, store);
    services.readLaunch = snapshots.get;
    live.launchConfiguration = {
      read: snapshots.get,
      executionSettings: (config) =>
        resolveLaunchExecutionSettings(config, { image: 'synthetic-image' }),
      assertCurrentCapabilities: vi.fn(async () => {}),
    };
    const config = await resolveLaunch(
      { repositoryId: 'repo-a', task: 'Frozen admission' },
      services,
    );
    const admit = (value: EffectiveLaunchConfig = config) =>
      snapshots.admit({
        config: value,
        requestDigest: value.digest,
        createPod: () =>
          resolved().createResolvedSession(
            value,
            'operator',
            { email: 'owner@invalid.example' },
            { type: 'human', userId: 'operator' },
          ).id,
      });
    return { store, services, snapshots, config, admit };
  }
  function insert(id: string, overrides: Partial<Parameters<PodRepository['insert']>[0]> = {}) {
    f.podRepo.insert({
      id,
      profileName: 'test-profile',
      task: `Synthetic ${id}`,
      status: 'queued',
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      executionTarget: 'local',
      branch: id,
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
      ...overrides,
    });
    return f.podRepo.getOrThrow(id);
  }
  return {
    ...f,
    get db() {
      return f.db;
    },
    live,
    context,
    captured,
    dependents,
    enqueueSession,
    events,
    memoryRepo,
    native,
    insert,
    resolved,
    legacy: () => createAdmissionLegacy(live, captured),
    queries: () => createAdmissionQueries(live, captured),
    analysis: () => createAdmissionAnalysisWorkspaces(live),
    series: () => createAdmissionSeriesDeletion(captured),
  };
}
