import type { ExecutionCapabilities } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { vi } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import type { LaunchResolutionServices } from '../configuration/launch-resolver.js';
import { environmentImageKey } from '../images/environment-image-key.js';
import { insertTestProfile } from './mock-helpers.js';

export const testExecutionCapabilities: ExecutionCapabilities = {
  target: 'local',
  available: true,
  defaults: { memoryGb: 2, cpus: 1, storageGb: null },
  maxMemoryGb: 16,
  maxCpus: 8,
  maxStorageGb: null,
  memoryTiersGb: null,
  sidecars: true,
  privilegedSidecars: false,
  sidecarStorageLimit: false,
  maxTotalMemoryGb: 16,
  maxTotalCpus: 8,
  sidecarDefaults: {
    'dagger-engine': { memoryGb: 2, cpus: 1, storageGb: null },
    postgres: { memoryGb: 1, cpus: 1, storageGb: null },
    redis: { memoryGb: 0.5, cpus: 0.5, storageGb: null },
  },
};

export function createTestConfiguration(db: Database.Database) {
  const store = createConfigurationStore(db);
  store.writeBatch([
    {
      id: 'env',
      kind: 'environment',
      name: 'Node',
      payload: { template: 'node22', capabilities: ['node'] },
    },
    {
      id: 'ai',
      kind: 'ai',
      name: 'Main AI',
      payload: {
        main: { providerAccountId: 'account', runtime: 'claude', model: 'claude-sonnet-4-6' },
      },
    },
    {
      id: 'flow',
      kind: 'workflow',
      name: 'Development',
      payload: { validationPhases: ['build', 'test'] },
    },
    {
      id: 'access',
      kind: 'githubAccess',
      name: 'Read current',
      payload: {
        rules: [{ id: 'read', repositories: { mode: 'current' }, operations: ['code.read'] }],
      },
    },
    {
      id: 'profile',
      kind: 'profile',
      name: 'Development',
      payload: { environmentId: 'env', aiId: 'ai', workflowId: 'flow', githubAccessId: 'access' },
    },
    ...['repo-a', 'repo-b'].map((id) => ({
      id,
      kind: 'repository' as const,
      name: id,
      payload: {
        provider: 'github',
        remote: `https://github.com/org/${id}`,
        providerRepositoryId: id,
        setups: [
          {
            id: 'default',
            name: 'Default',
            buildCommand: 'npm run build',
            testCommand: 'npm test',
          },
        ],
        defaultSetupId: 'default',
        usualProfileId: 'profile',
      },
    })),
  ]);
  const services: LaunchResolutionServices = {
    store,
    resolveEnvironment: vi.fn(async (environment) => {
      const binding = {
        pinnedBase: `base@sha256:${'a'.repeat(64)}`,
        platform: 'linux/amd64' as const,
        agentToolingDigest: 'b'.repeat(64),
        toolInstallCommands: [],
      };
      return { ...binding, imageKey: environmentImageKey({ environment, ...binding }) };
    }),
    githubRepositories: vi.fn(async (_rule, repo) =>
      repo?.providerRepositoryId ? [repo.providerRepositoryId] : [],
    ),
    referenceRevision: vi.fn(async () => 'a'.repeat(40)),
    githubWorkflows: vi.fn(async (rule) => rule),
    skillContent: vi.fn(async () => '# Fixed skill content'),
    resolveAgentRoute: vi.fn<LaunchResolutionServices['resolveAgentRoute']>(async (route) => ({
      accountId: route.providerAccountId,
      providerId: route.runtime === 'codex' ? 'openai' : 'anthropic',
      adapter: route.runtime === 'codex' ? 'openai' : 'anthropic',
      createdAt: '2026-09-13T00:00:00Z',
    })),
    executionCapabilities: vi.fn(async () => testExecutionCapabilities),
    assertCapabilities: vi.fn(async () => {}),
    resolveCredentialReferences: vi.fn(async () => ({})),
  };
  return { store, services };
}
export function insertConfigurationTestPod(db: Database.Database, id: string) {
  if (!db.prepare('SELECT 1 FROM profiles WHERE name=?').get('test-profile')) insertTestProfile(db);
  db.prepare(`INSERT INTO pods(id,profile_name,task,model,runtime,branch,user_id)
    VALUES(?, 'test-profile', 'Test task', 'claude-sonnet-4-6', 'claude', ?, 'test-user')`).run(
    id,
    `autopod/${id}`,
  );
  return id;
}
