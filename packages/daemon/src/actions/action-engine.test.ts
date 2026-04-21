import type { ActionDefinition, ActionPolicy } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActionEngine, createActionEngine } from './action-engine.js';
import type { ActionRegistry } from './action-registry.js';
import type { ActionAuditRepository } from './audit-repository.js';

// Prevent real network calls — handlers throw immediately so tests stay fast
vi.mock('./handlers/github-handler.js', () => ({
  createGitHubHandler: () => ({
    execute: vi.fn().mockRejectedValue(new Error('GitHub API unavailable in test environment')),
  }),
}));
vi.mock('./handlers/ado-handler.js', () => ({
  createAdoHandler: () => ({
    execute: vi.fn().mockRejectedValue(new Error('ADO API unavailable in test environment')),
  }),
}));
vi.mock('./handlers/azure-logs-handler.js', () => ({
  createAzureLogsHandler: () => ({
    execute: vi.fn().mockRejectedValue(new Error('Azure Logs API unavailable in test environment')),
  }),
}));
vi.mock('./generic-http-handler.js', () => ({
  createGenericHttpHandler: () => ({
    execute: vi.fn().mockRejectedValue(new Error('HTTP handler unavailable in test environment')),
  }),
}));

// ─── Test helpers ───────────────────────────────────────────────

const testAction: ActionDefinition = {
  name: 'read_issue',
  description: 'Read a GitHub issue',
  group: 'github-issues',
  handler: 'github',
  params: {
    repo: { type: 'string', required: true, description: 'Repository' },
    issue_number: { type: 'number', required: true, description: 'Issue number' },
  },
  response: {
    fields: ['title', 'body', 'state'],
    redactFields: ['user.login'],
  },
};

const testPolicy: ActionPolicy = {
  enabledGroups: ['github-issues'],
  sanitization: { preset: 'standard' },
};

function createMockRegistry(actions: ActionDefinition[] = [testAction]): ActionRegistry {
  return {
    getAvailableActions: vi.fn(() => actions),
    getAction: vi.fn((name: string) => actions.find((a) => a.name === name)),
    getAllDefaults: vi.fn(() => actions),
  };
}

function createMockAuditRepo(): ActionAuditRepository {
  return {
    insert: vi.fn(),
    listBySession: vi.fn(() => []),
    countBySession: vi.fn(() => 0),
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('ActionEngine', () => {
  let engine: ActionEngine;
  let registry: ReturnType<typeof createMockRegistry>;
  let auditRepo: ReturnType<typeof createMockAuditRepo>;

  beforeEach(() => {
    registry = createMockRegistry();
    auditRepo = createMockAuditRepo();
    engine = createActionEngine({
      registry,
      auditRepo,
      logger: pino({ level: 'silent' }),
      getSecret: (ref) => {
        if (ref === 'GITHUB_TOKEN' || ref === 'github-pat')
          return 'ghp_test_token_000000000000000000000000000000';
        if (ref === 'ADO_PAT' || ref === 'ado-pat') return 'test-ado-pat';
        return undefined;
      },
    });
  });

  it('returns error when action not found', async () => {
    const result = await engine.execute(
      { podId: 'sess-1', actionName: 'nonexistent', params: {} },
      testPolicy,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for missing required params', async () => {
    const result = await engine.execute(
      { podId: 'sess-1', actionName: 'read_issue', params: { repo: 'org/repo' } },
      testPolicy,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('issue_number');
  });

  it('returns error for wrong param type', async () => {
    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'org/repo', issue_number: 'not-a-number' },
      },
      testPolicy,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('must be a number');
  });

  it('returns error when approval is required', async () => {
    const policyWithApproval: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [{ action: 'read_issue', requiresApproval: true }],
    };

    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'org/repo', issue_number: 1 },
      },
      policyWithApproval,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires human approval');
  });

  it('returns error when resource not allowed', async () => {
    const policyWithResource: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [{ action: 'read_issue', allowedResources: ['org/allowed-repo'] }],
    };

    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'org/forbidden-repo', issue_number: 1 },
      },
      policyWithResource,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed for resource');
  });

  it('allows when resource is an exact match in allowedResources', async () => {
    const policyWithResource: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [{ action: 'read_issue', allowedResources: ['org/allowed-repo'] }],
    };

    // This will fail because we don't have a real GitHub API, but it should get past the resource check
    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'org/allowed-repo', issue_number: 1 },
      },
      policyWithResource,
    );
    // Will fail at the handler level (network), but should NOT fail at resource check
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('allows when resource matches an org/* wildcard', async () => {
    const policyWithWildcard: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [{ action: 'read_issue', allowedResources: ['myorg/*'] }],
    };

    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'myorg/any-repo', issue_number: 1 },
      },
      policyWithWildcard,
    );
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('blocks when resource does not match an org/* wildcard', async () => {
    const policyWithWildcard: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [{ action: 'read_issue', allowedResources: ['myorg/*'] }],
    };

    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'other-org/repo', issue_number: 1 },
      },
      policyWithWildcard,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed for resource');
  });

  it('allows any resource when allowedResources contains *', async () => {
    const policyWithStar: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [{ action: 'read_issue', allowedResources: ['*'] }],
    };

    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'totally/different', issue_number: 1 },
      },
      policyWithStar,
    );
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('writes audit entry on success', async () => {
    // Use a custom action with http handler that we can't actually call,
    // so this tests the error audit path
    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'org/repo', issue_number: 1 },
      },
      testPolicy,
    );

    // Handler will fail (no real API), so audit entry should be for error
    expect(auditRepo.insert).toHaveBeenCalled();
    const auditCall = (auditRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(auditCall?.podId).toBe('sess-1');
    expect(auditCall?.actionName).toBe('read_issue');
  });

  it('allows access to all repos when multiple per-repo overrides are configured', async () => {
    const policy: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [
        { action: 'read_issue', allowedResources: ['org/repo-a'] },
        { action: 'read_issue', allowedResources: ['org/repo-b'] },
      ],
    };

    const resultA = await engine.execute(
      { podId: 'sess-1', actionName: 'read_issue', params: { repo: 'org/repo-a', issue_number: 1 } },
      policy,
    );
    expect(resultA.error).not.toContain('not allowed for resource');

    const resultB = await engine.execute(
      { podId: 'sess-1', actionName: 'read_issue', params: { repo: 'org/repo-b', issue_number: 1 } },
      policy,
    );
    expect(resultB.error).not.toContain('not allowed for resource');

    const resultC = await engine.execute(
      { podId: 'sess-1', actionName: 'read_issue', params: { repo: 'org/forbidden', issue_number: 1 } },
      policy,
    );
    expect(resultC.success).toBe(false);
    expect(resultC.error).toContain('not allowed for resource');
  });

  it('matches URL-encoded resource patterns against decoded params', async () => {
    const policy: ActionPolicy = {
      ...testPolicy,
      // Pattern stored as copy-pasted ADO URL segment (@ encoded as %40)
      actionOverrides: [{ action: 'read_issue', allowedResources: ['org/TeamPlanner%40-V3%40'] }],
    };

    const result = await engine.execute(
      { podId: 'sess-1', actionName: 'read_issue', params: { repo: 'org/TeamPlanner@-V3@', issue_number: 1 } },
      policy,
    );
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('skips disabled overrides when evaluating allowedResources', async () => {
    const policy: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [
        { action: 'read_issue', allowedResources: ['org/restricted'], disabled: true },
      ],
    };

    // Disabled override should be ignored → no allowedResources constraint active
    const result = await engine.execute(
      { podId: 'sess-1', actionName: 'read_issue', params: { repo: 'org/any-repo', issue_number: 1 } },
      policy,
    );
    expect(result.error).not.toContain('not allowed for resource');
  });

  // ─── ADO composite resource matching ────────────────────────────────────────
  // ADO actions pass org + project + repo as separate params. The engine builds
  // "org/project/repo" so that allowedResources patterns like "org/project" work
  // via prefix-segment matching without requiring an explicit "/*" wildcard.

  const adoReadFileAction: ActionDefinition = {
    name: 'ado_read_file',
    description: 'Read a file from ADO',
    group: 'ado-code',
    handler: 'ado',
    params: {
      org: { type: 'string', required: true, description: 'ADO org' },
      project: { type: 'string', required: true, description: 'ADO project' },
      repo: { type: 'string', required: true, description: 'Repo name' },
      path: { type: 'string', required: true, description: 'File path' },
    },
    response: { fields: ['content'] },
  };

  const adoPolicy: ActionPolicy = {
    enabledGroups: ['ado-code'],
    sanitization: { preset: 'standard' },
  };

  it('allows ado_read_file when org/project pattern prefix-matches org/project/repo resource', async () => {
    const adoEngine = createActionEngine({
      registry: createMockRegistry([adoReadFileAction]),
      auditRepo: createMockAuditRepo(),
      logger: pino({ level: 'silent' }),
      getSecret: () => 'test-ado-pat',
    });

    const result = await adoEngine.execute(
      {
        podId: 'sess-1',
        actionName: 'ado_read_file',
        params: { org: '365projectum', project: 'TeamPlanner@V3@', repo: 'teamplanner-pipelines', path: 'file.yml' },
      },
      { ...adoPolicy, actionOverrides: [{ action: 'ado_read_file', allowedResources: ['365projectum/TeamPlanner@V3@'] }] },
    );
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('allows ado_read_file when org/project/*-wildcard matches org/project/repo resource', async () => {
    const adoEngine = createActionEngine({
      registry: createMockRegistry([adoReadFileAction]),
      auditRepo: createMockAuditRepo(),
      logger: pino({ level: 'silent' }),
      getSecret: () => 'test-ado-pat',
    });

    const result = await adoEngine.execute(
      {
        podId: 'sess-1',
        actionName: 'ado_read_file',
        params: { org: '365projectum', project: 'TeamPlanner@V3@', repo: 'any-repo', path: 'file.yml' },
      },
      { ...adoPolicy, actionOverrides: [{ action: 'ado_read_file', allowedResources: ['365projectum/TeamPlanner@V3@/*'] }] },
    );
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('allows ado_read_file with URL-encoded org/project pattern via prefix match', async () => {
    const adoEngine = createActionEngine({
      registry: createMockRegistry([adoReadFileAction]),
      auditRepo: createMockAuditRepo(),
      logger: pino({ level: 'silent' }),
      getSecret: () => 'test-ado-pat',
    });

    const result = await adoEngine.execute(
      {
        podId: 'sess-1',
        actionName: 'ado_read_file',
        params: { org: '365projectum', project: 'TeamPlanner@V3@', repo: 'teamplanner-pipelines', path: 'file.yml' },
      },
      { ...adoPolicy, actionOverrides: [{ action: 'ado_read_file', allowedResources: ['365projectum/TeamPlanner%40V3%40'] }] },
    );
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('blocks ado_read_file when org/project does not match', async () => {
    const adoEngine = createActionEngine({
      registry: createMockRegistry([adoReadFileAction]),
      auditRepo: createMockAuditRepo(),
      logger: pino({ level: 'silent' }),
      getSecret: () => 'test-ado-pat',
    });

    const result = await adoEngine.execute(
      {
        podId: 'sess-1',
        actionName: 'ado_read_file',
        params: { org: 'other-org', project: 'SomeProject', repo: 'some-repo', path: 'file.yml' },
      },
      { ...adoPolicy, actionOverrides: [{ action: 'ado_read_file', allowedResources: ['365projectum/TeamPlanner@V3@'] }] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed for resource');
  });

  it('getAvailableActions delegates to registry', () => {
    const actions = engine.getAvailableActions(testPolicy);
    expect(registry.getAvailableActions).toHaveBeenCalledWith(testPolicy);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.name).toBe('read_issue');
  });

  it('validates enum params', async () => {
    const enumAction: ActionDefinition = {
      name: 'search_issues',
      description: 'Search issues',
      group: 'github-issues',
      handler: 'github',
      params: {
        repo: { type: 'string', required: true, description: 'Repo' },
        query: { type: 'string', required: true, description: 'Query' },
        state: {
          type: 'string',
          required: false,
          description: 'State',
          enum: ['open', 'closed', 'all'],
        },
      },
      response: { fields: ['number', 'title'] },
    };
    registry = createMockRegistry([enumAction]);
    engine = createActionEngine({
      registry,
      auditRepo,
      logger: pino({ level: 'silent' }),
      getSecret: () => undefined,
    });

    const result = await engine.execute(
      {
        podId: 'sess-1',
        actionName: 'search_issues',
        params: { repo: 'org/repo', query: 'bug', state: 'invalid' },
      },
      { ...testPolicy },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('must be one of');
  });
});
