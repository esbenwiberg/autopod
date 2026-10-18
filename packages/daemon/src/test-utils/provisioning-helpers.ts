import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { createEscalationRepository } from '../pods/escalation-repository.js';
import { createEventBus } from '../pods/event-bus.js';
import { createEventRepository } from '../pods/event-repository.js';
import { createFixFeedbackRepository } from '../pods/fix-feedback-repository.js';
import { createNudgeRepository } from '../pods/nudge-repository.js';
import { buildPrFixTask, createPodManager } from '../pods/pod-manager.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { createProviderAttemptContext } from '../pods/provider-attempt-context.js';
import { createProviderAttemptRepository } from '../pods/provider-attempt-repository.js';
import { createProvisioningAgentMaterials } from '../pods/provisioning-agent-materials.js';
import { createProvisioningContainer } from '../pods/provisioning-container.js';
import { createProvisioningMaterials } from '../pods/provisioning-materials.js';
import type {
  ProvisioningCaptured,
  ProvisioningInput,
  ProvisioningRunControls,
} from '../pods/provisioning-ports.js';
import { createProvisioningSandboxState } from '../pods/provisioning-sandbox-state.js';
import { createProvisioningSessionMaterials } from '../pods/provisioning-session-materials.js';
import { createProvisioningWorkflow } from '../pods/provisioning-workflow.js';
import { createProvisioningWorkspacePopulation } from '../pods/provisioning-workspace-population.js';
import { createProvisioningWorkspace } from '../pods/provisioning-workspace.js';
import { createValidationRepository } from '../pods/validation-repository.js';
import { createProfileStore } from '../profiles/index.js';
import { createProviderAccountStore } from '../provider-accounts/index.js';
import { createTestContext } from './mock-helpers.js';

export function createProvisioningFixture(disk = false) {
  const ctx = createTestContext();
  const directory = mkdtempSync(join(tmpdir(), 'provisioning-'));
  const filename = join(directory, 'state.db');
  const previousEnvironment = Object.fromEntries(
    ['DATA_DIR', 'AUTOPOD_CLAUDE_STATE_DIR', 'AUTOPOD_CODEX_STATE_DIR'].map((name) => [
      name,
      process.env[name],
    ]),
  );
  process.env.DATA_DIR = directory;
  process.env.AUTOPOD_CLAUDE_STATE_DIR = join(directory, 'claude');
  process.env.AUTOPOD_CODEX_STATE_DIR = join(directory, 'codex');
  let db = ctx.db;
  if (disk) {
    writeFileSync(filename, db.serialize());
    db = new Database(filename);
    db.pragma('foreign_keys=ON');
  }
  const podRepo = createPodRepository(db);
  const profiles = createProfileStore(db);
  const accounts = createProviderAccountStore(db);
  accounts.create({
    id: 'account',
    name: 'Synthetic account',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'synthetic-provisioning-key' },
  });
  profiles.update('test-profile', { providerAccountId: 'account', modelProvider: 'anthropic' });
  const eventRepo = createEventRepository(db);
  const escalationRepo = createEscalationRepository(db);
  const nudgeRepo = createNudgeRepository(db);
  const fixFeedbackRepo = createFixFeedbackRepository(db);
  const validationRepo = createValidationRepository(db);
  const repo = createProviderAttemptRepository(db);
  const effects: string[] = [];
  podRepo.insert({
    id: 'prepare',
    profileName: 'test-profile',
    task: 'Original task',
    status: 'queued',
    runtime: 'claude',
    model: 'claude-sonnet-4-6',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    providerAccountIdSnapshot: 'account',
    providerIdSnapshot: 'anthropic',
  });
  const deps = {
    ...ctx.deps,
    podRepo,
    profileStore: profiles,
    providerAccountStore: accounts,
    providerAttemptRepo: repo,
    escalationRepo,
    nudgeRepo,
    fixFeedbackRepo,
    validationRepo,
    eventRepo,
    eventBus: createEventBus(eventRepo, ctx.deps.logger),
  };
  const executionForPod = (pod: ReturnType<typeof podRepo.getOrThrow>) =>
    pod.profileSnapshot ?? profiles.get(pod.profileName);
  const attempts = createProviderAttemptContext(deps, {
    podRepo,
    providerAccountStore: accounts,
    profileStore: profiles,
    executionForPod,
    activeAgentRuns: new Map(),
  });
  const materials = createProvisioningMaterials(promisify(execFile));
  const sandbox = createProvisioningSandboxState(deps, {
    podRepo,
    containerManagerFactory: deps.containerManagerFactory,
    logger: deps.logger,
  });
  const captured: ProvisioningCaptured = {
    ...materials,
    ...sandbox,
    ...attempts,
    podRepo,
    profileStore: profiles,
    providerAccountStore: accounts,
    providerCatalog: undefined,
    containerManagerFactory: deps.containerManagerFactory,
    worktreeManager: ctx.worktreeManager,
    logger: deps.logger,
    repoScanner: undefined,
    executionCredentialsFor: vi.fn(() => undefined),
    resolveGitCredential: vi.fn(async () => 'synthetic-git-key'),
    resolveEffectiveBoundProfile: (pod) => executionForPod(pod),
    persistRuntimeCredentialsForPod: vi.fn(async () => {}),
    syncWorkspaceBack: vi.fn(async () => ({ pushed: false })),
    stopSandboxPreviewProxy: vi.fn(async () => {}),
    killSidecarsForPod: vi.fn(async () => {}),
    destroyPodNetwork: vi.fn(async () => {}),
    injectionsForPod: () => deps.daemonConfig,
    hostnameFromUrl: (url) => new URL(url).hostname,
    portFromUrl: (url) => Number(new URL(url).port || '80'),
    mcpBaseUrl: deps.mcpBaseUrl,
    networkManager: undefined,
    sidecarManager: undefined,
    allocateHostPort: vi.fn(() => 32123),
    CONTAINER_APP_PORT: 3000,
    execFileAsync: promisify(execFile),
    startHaproxyDenyReceiver: vi.fn(async () => {}),
    fixFeedbackRepo,
    buildPrFixTask,
    safetyEventsRepo: undefined,
    validationRepo,
    escalationRepo,
    progressEventRepo: undefined,
    emitActivityStatus: vi.fn((_id, message) => {
      effects.push(message);
    }),
    transition: vi.fn((pod, status, extra) => {
      effects.push(status);
      podRepo.update(pod.id, { ...extra, status });
      return podRepo.getOrThrow(pod.id);
    }),
  };
  const run: ProvisioningRunControls = {
    startupAdmission: undefined,
    finishStartup: vi.fn((outcome) => {
      effects.push(`startup:${outcome}`);
      const admission = run.startupAdmission;
      if (admission) {
        podRepo.sandboxStartupRetries?.finish(
          admission.id,
          outcome,
          admission.started === null || outcome === 'unknown' ? null : 1,
        );
        run.startupAdmission = undefined;
      }
    }),
    emitStatus: vi.fn((message) => {
      effects.push(message);
    }),
    assertStartupCurrent: vi.fn(),
    stagedReferenceArchivePaths: new Set(),
  };
  const input = (): ProvisioningInput => ({
    podId: 'prepare',
    pod: podRepo.getOrThrow('prepare'),
    launchConfig: deps.launchConfiguration?.read('prepare') ?? null,
    lifecycleGeneration: podRepo.getOrThrow('prepare').lifecycleGeneration,
    run,
  });
  let workspacePromise:
    | ReturnType<ReturnType<typeof createProvisioningWorkspace>['prepareWorkspace']>
    | undefined;
  const workspace = () => {
    workspacePromise ??= createProvisioningWorkspace(deps, captured).prepareWorkspace(input());
    return workspacePromise;
  };
  let containerPromise:
    | ReturnType<ReturnType<typeof createProvisioningContainer>['prepareContainer']>
    | undefined;
  const container = () => {
    containerPromise ??= workspace().then((result) => {
      if (result.kind !== 'ready') throw new Error('Workspace fixture halted');
      return createProvisioningContainer(deps, captured).prepareContainer(result);
    });
    return containerPromise;
  };
  let populationPromise:
    | ReturnType<ReturnType<typeof createProvisioningWorkspacePopulation>['populateWorkspace']>
    | undefined;
  const population = () => {
    populationPromise ??= container().then((result) =>
      createProvisioningWorkspacePopulation(deps, captured).populateWorkspace(result),
    );
    return populationPromise;
  };
  let sessionPromise:
    | ReturnType<ReturnType<typeof createProvisioningSessionMaterials>['prepareSessionMaterials']>
    | undefined;
  const session = () => {
    sessionPromise ??= population().then((result) =>
      createProvisioningSessionMaterials(deps, captured).prepareSessionMaterials(result),
    );
    return sessionPromise;
  };
  const agent = async () => {
    const result = await session();
    if (result.kind !== 'ready') throw new Error('Session fixture halted');
    return createProvisioningAgentMaterials(deps, captured).prepareAgentMaterials(result);
  };
  return {
    ctx,
    get db() {
      return db;
    },
    directory,
    filename,
    deps,
    captured,
    run,
    effects,
    podRepo,
    profiles,
    accounts,
    repo,
    materials,
    sandbox,
    cm: ctx.containerManager,
    worktreeManager: ctx.worktreeManager,
    pod: () => podRepo.getOrThrow('prepare'),
    input,
    workspace,
    container,
    population,
    session,
    agent,
    workflow: () => createProvisioningWorkflow(deps, captured),
    manager: () => createPodManager(deps),
    reopen() {
      if (!disk) throw new Error('Expected file fixture');
      db.close();
      db = new Database(filename);
      db.pragma('foreign_keys=ON');
      return {
        pods: createPodRepository(db),
        profiles: createProfileStore(db),
        accounts: createProviderAccountStore(db),
      };
    },
    close() {
      if (db !== ctx.db) db.close();
      ctx.db.close();
      rmSync(directory, { recursive: true, force: true });
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    },
  };
}
