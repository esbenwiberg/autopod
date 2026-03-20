import type { ActionDefinition, ActionPolicy } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActionEngine, createActionEngine } from './action-engine.js';
import type { ActionRegistry } from './action-registry.js';
import type { ActionAuditRepository } from './audit-repository.js';

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
      { sessionId: 'sess-1', actionName: 'nonexistent', params: {} },
      testPolicy,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for missing required params', async () => {
    const result = await engine.execute(
      { sessionId: 'sess-1', actionName: 'read_issue', params: { repo: 'org/repo' } },
      testPolicy,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('issue_number');
  });

  it('returns error for wrong param type', async () => {
    const result = await engine.execute(
      {
        sessionId: 'sess-1',
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
        sessionId: 'sess-1',
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
        sessionId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'org/forbidden-repo', issue_number: 1 },
      },
      policyWithResource,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed for resource');
  });

  it('allows when resource is in allowedResources', async () => {
    const policyWithResource: ActionPolicy = {
      ...testPolicy,
      actionOverrides: [{ action: 'read_issue', allowedResources: ['org/allowed-repo'] }],
    };

    // This will fail because we don't have a real GitHub API, but it should get past the resource check
    const result = await engine.execute(
      {
        sessionId: 'sess-1',
        actionName: 'read_issue',
        params: { repo: 'org/allowed-repo', issue_number: 1 },
      },
      policyWithResource,
    );
    // Will fail at the handler level (network), but should NOT fail at resource check
    expect(result.error).not.toContain('not allowed for resource');
  });

  it('writes audit entry on success', async () => {
    // Use a custom action with http handler that we can't actually call,
    // so this tests the error audit path
    const result = await engine.execute(
      {
        sessionId: 'sess-1',
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
    expect(auditCall?.sessionId).toBe('sess-1');
    expect(auditCall?.actionName).toBe('read_issue');
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
        sessionId: 'sess-1',
        actionName: 'search_issues',
        params: { repo: 'org/repo', query: 'bug', state: 'invalid' },
      },
      { ...testPolicy },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('must be one of');
  });
});
