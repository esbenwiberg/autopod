import type { MemoryEntry, Pod, Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  generateSystemInstructions,
  sortMemoriesForIndex,
} from './system-instructions-generator.js';

function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    name: 'test-profile',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 120,
    smokePages: [],
    maxValidationAttempts: 3,
    defaultModel: 'opus',
    defaultRuntime: 'claude',
    executionTarget: 'local',
    customInstructions: null,
    escalation: {
      askHuman: true,
      askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
      advisor: { enabled: false },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    },
    extends: null,
    warmImageTag: null,
    warmImageBuiltAt: null,
    mcpServers: [],
    claudeMdSections: [],
    skills: [],
    networkPolicy: null,
    actionPolicy: null,
    outputMode: 'pr' as const,
    modelProvider: 'anthropic' as const,
    providerCredentials: null,
    testCommand: null,
    prProvider: 'github' as const,
    adoPat: null,
    privateRegistries: [],
    registryPat: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSession(overrides?: Partial<Pod>): Pod {
  return {
    id: 'abc12345',
    profileName: 'test-profile',
    task: 'Add dark mode',
    status: 'running',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/abc12345',
    containerId: null,
    worktreePath: null,
    validationAttempts: 0,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-01-01T00:00:00Z',
    userId: 'user1',
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    previewUrl: null,
    prUrl: null,
    plan: null,
    progress: null,
    acceptanceCriteria: null,
    claudeSessionId: null,
    pimGroups: null,
    ...overrides,
  };
}

describe('generateSystemInstructions', () => {
  it('includes pod id, profile, and task', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/abc12345',
    );

    expect(md).toContain('Pod ID: abc12345');
    expect(md).toContain('Profile: test-profile');
    expect(md).toContain('Add dark mode');
    expect(md).toContain('<!-- BEGIN USER TASK -->');
  });

  it('includes MCP server URL', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/abc12345',
    );

    expect(md).toContain('http://localhost:8080/mcp/abc12345');
    expect(md).toContain('ask_human');
    expect(md).toContain('ask_ai');
    expect(md).toContain('report_blocker');
  });

  it('includes build and run commands', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('`npm run build`');
    expect(md).toContain('`npm start`');
    expect(md).toContain('/health');
  });

  it('includes validation pages when present', () => {
    const profile = makeProfile({
      smokePages: [
        {
          path: '/dashboard',
          assertions: [
            { selector: '.header', type: 'exists' },
            { selector: '.title', type: 'text_contains', value: 'Dashboard' },
          ],
        },
        { path: '/settings' },
      ],
    });

    const md = generateSystemInstructions(profile, makeSession(), 'http://localhost:8080/mcp/x');

    expect(md).toContain('## Smoke Pages');
    expect(md).toContain('- /dashboard');
    expect(md).toContain('  - exists: .header');
    expect(md).toContain('  - text_contains: .title = "Dashboard"');
    expect(md).toContain('- /settings');
  });

  it('emits a ToolSearch select line when an injected MCP server has toolNames', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
      {
        injectedMcpServers: [
          {
            type: 'stdio',
            name: 'serena',
            command: 'serena',
            description: 'LSP-backed semantic code navigation.',
            toolNames: ['mcp__serena__find_symbol', 'mcp__serena__find_referencing_symbols'],
          },
        ],
      },
    );

    expect(md).toContain('### serena');
    expect(md).toContain(
      'First turn: `ToolSearch select:mcp__serena__find_symbol,mcp__serena__find_referencing_symbols`',
    );
  });

  it('omits the ToolSearch select line when toolNames is missing', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
      {
        injectedMcpServers: [
          {
            type: 'stdio',
            name: 'serena',
            command: 'serena',
          },
        ],
      },
    );

    expect(md).toContain('### serena');
    expect(md).not.toContain('ToolSearch select:');
  });

  it('omits validation pages section when empty', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Smoke Pages');
  });

  it('includes custom instructions when present', () => {
    const profile = makeProfile({
      customInstructions: 'Always use TypeScript strict mode.',
    });

    const md = generateSystemInstructions(profile, makeSession(), 'http://localhost:8080/mcp/x');

    expect(md).toContain('## Custom Instructions');
    expect(md).toContain('Always use TypeScript strict mode.');
  });

  it('omits custom instructions section when null', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Custom Instructions');
  });

  it('includes acceptance criteria when pod has ACs', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        acceptanceCriteria: [
          {
            type: 'web',
            test: 'Settings page has a dark mode toggle',
            pass: 'toggle visible',
            fail: 'no toggle',
          },
          {
            type: 'none',
            test: 'Toggle persists after refresh',
            pass: 'value retained',
            fail: 'value lost',
          },
        ],
      }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).toContain('## Acceptance Criteria');
    expect(md).toContain('- [browser] Settings page has a dark mode toggle');
    expect(md).toContain('- [code] Toggle persists after refresh');
    expect(md).toContain('independently verify');
  });

  it('omits acceptance criteria section when null', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({ acceptanceCriteria: null }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Acceptance Criteria');
  });

  it('omits acceptance criteria section when empty array', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({ acceptanceCriteria: [] }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Acceptance Criteria');
  });

  it('includes validate_in_browser tool in MCP tools list', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).toContain('validate_in_browser');
  });

  it('includes self-validation section when pod has acceptance criteria', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        acceptanceCriteria: [
          { type: 'none', test: 'Page loads without errors', pass: 'exit 0', fail: 'any error' },
        ],
      }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).toContain('### Self-Validation');
    expect(md).toContain('validate_in_browser');
    expect(md).toContain('localhost URL');
    expect(md).toContain('NOT shared with the independent reviewer');
  });

  it('omits self-validation section when no acceptance criteria', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({ acceptanceCriteria: null }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('### Self-Validation');
  });

  it('includes guidelines', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('## Guidelines');
    expect(md).toContain('Commit after every meaningful unit of work');
    expect(md).toContain('Do NOT modify configuration files');
  });

  it('includes advisor section when advisor is enabled', () => {
    const profile = makeProfile({
      escalation: {
        askHuman: true,
        askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: true },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
    });

    const md = generateSystemInstructions(profile, makeSession(), 'http://localhost:8080/mcp/x');

    expect(md).toContain('## AI Advisor');
    expect(md).toContain('ask_ai');
    expect(md).toContain('Before writing complex logic');
    expect(md).toContain('Before completing the task');
  });

  it('omits advisor section when advisor is disabled', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## AI Advisor');
  });

  it('includes injected skills section with descriptions', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
      {
        injectedSkills: [
          {
            name: 'review',
            source: { type: 'local', path: '/s/r.md' },
            description: 'Review PR changes',
          },
          { name: 'deploy', source: { type: 'github', repo: 'org/skills' } },
        ],
      },
    );

    expect(md).toContain('## Available Skills');
    expect(md).toContain('`/review` — Review PR changes');
    expect(md).toContain('`/deploy`');
    // deploy has no description so no dash after it
    expect(md).not.toContain('`/deploy` —');
  });

  it('omits skills section when no skills injected', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Available Skills');
  });

  it('includes PIM groups section when pod has pimGroups', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        pimGroups: [
          {
            groupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            displayName: 'Log Analytics Reader',
            justification: 'Read production logs',
          },
          {
            groupId: 'ffffffff-1111-2222-3333-444444444444',
          },
        ],
      }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).toContain('## Azure PIM Groups');
    expect(md).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(md).toContain('Log Analytics Reader');
    expect(md).toContain('Read production logs');
    expect(md).toContain('ffffffff-1111-2222-3333-444444444444');
    expect(md).toContain('not as a workaround');
  });

  it('omits PIM groups section when pimGroups is null', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({ pimGroups: null }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Azure PIM Groups');
  });

  it('omits PIM groups section when pimGroups is empty array', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({ pimGroups: [] }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Azure PIM Groups');
  });

  describe('network policy instructions', () => {
    it('restricts network access when policy is enabled without replaceDefaults', () => {
      const md = generateSystemInstructions(
        makeProfile({
          networkPolicy: {
            enabled: true,
            mode: 'restricted',
            allowedHosts: [],
            replaceDefaults: false,
          },
        }),
        makeSession(),
        'http://localhost:8080/mcp/x',
      );
      expect(md).toContain('restricted to package registries');
      expect(md).toContain('action tools');
    });

    it('dynamically describes GitHub coverage when GitHub action groups are enabled', () => {
      const md = generateSystemInstructions(
        makeProfile({
          networkPolicy: {
            enabled: true,
            mode: 'restricted',
            allowedHosts: [],
            replaceDefaults: false,
          },
        }),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          availableActions: [
            {
              name: 'read_issue',
              description: 'Read a GitHub issue',
              group: 'github-issues',
              params: { repo: { type: 'string', required: true, description: 'repo' } },
            },
            {
              name: 'read_pr',
              description: 'Read a GitHub PR',
              group: 'github-prs',
              params: { repo: { type: 'string', required: true, description: 'repo' } },
            },
          ],
        },
      );
      expect(md).toContain('GitHub issues, PRs');
      expect(md).toContain('MUST use these MCP action tools');
      expect(md).toContain('Do not use WebFetch, curl, gh CLI');
    });

    it('lists action tools in the same Tools bullet list as escalation tools', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          availableActions: [
            {
              name: 'read_issue',
              description: 'Read a GitHub issue',
              group: 'github-issues',
              params: { repo: { type: 'string', required: true, description: 'repo' } },
            },
          ],
        },
      );
      // Action tools should be in the same bullet list as escalation tools
      expect(md).toContain('  - read_issue — Read a GitHub issue');
      // Should appear after the escalation tools
      expect(md).toContain('  - ask_human');
      // No separate sub-header
      expect(md).not.toContain('Action tools');
    });

    it('dynamically describes ADO coverage when ado-workitems group is enabled', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          availableActions: [
            {
              name: 'read_workitem',
              description: 'Read an ADO work item',
              group: 'ado-workitems',
              params: { id: { type: 'number', required: true, description: 'Work item ID' } },
            },
          ],
        },
      );
      expect(md).toContain('ADO work items');
      expect(md).toContain('MUST use these MCP action tools');
    });

    it('dynamically describes ADO PR and code coverage when ado-prs and ado-code groups are enabled', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          availableActions: [
            {
              name: 'ado_read_pr',
              description: 'Read an ADO pull request',
              group: 'ado-prs',
              params: { id: { type: 'number', required: true, description: 'PR ID' } },
            },
            {
              name: 'ado_read_file',
              description: 'Read a file from ADO',
              group: 'ado-code',
              params: { path: { type: 'string', required: true, description: 'File path' } },
            },
          ],
        },
      );
      expect(md).toContain('ADO PRs, code');
      expect(md).toContain('MUST use these MCP action tools');
      expect(md).toContain('dev.azure.com');
    });

    it('uses generic phrasing for custom action groups', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          availableActions: [
            {
              name: 'my_tool',
              description: 'Custom tool',
              group: 'custom',
              params: { q: { type: 'string', required: true, description: 'query' } },
            },
          ],
        },
      );
      expect(md).toContain('Action tools are available on the Escalation MCP server');
      expect(md).not.toContain('MUST use these MCP action tools for these domains');
    });

    it('mentions WebFetch constraint for research pods with explicit allowed hosts', () => {
      const md = generateSystemInstructions(
        makeProfile({
          networkPolicy: {
            enabled: true,
            mode: 'restricted',
            allowedHosts: ['docs.example.com'],
            replaceDefaults: true,
          },
        }),
        makeSession(),
        'http://localhost:8080/mcp/x',
      );
      expect(md).toContain('Only WebFetch/curl to the allowed domains');
      expect(md).toContain('docs.example.com');
    });
  });

  describe('memory index', () => {
    function makeMemory(overrides: Partial<MemoryEntry>): MemoryEntry {
      return {
        id: 'mem1',
        scope: 'global',
        scopeId: null,
        path: '/conventions/test.md',
        content: 'Full content that should not appear in the index.',
        contentSha256: 'abc123',
        version: 1,
        approved: true,
        createdByPodId: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('omits memory section when no memories provided', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
      );
      expect(md).not.toContain('## Available Memory');
    });

    it('omits memory section when memories is empty array', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        { memories: [] },
      );
      expect(md).not.toContain('## Available Memory');
    });

    it('renders index with path, scope, and id — not full content', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          memories: [
            makeMemory({
              id: 'mem-abc',
              scope: 'global',
              path: '/conventions/commits.md',
              content: 'This is the full content of the commits convention.',
            }),
            makeMemory({
              id: 'mem-def',
              scope: 'profile',
              scopeId: 'test-profile',
              path: '/patterns/auth-flow.md',
              content: 'Detailed auth flow documentation here.',
            }),
          ],
        },
      );

      expect(md).toContain('## Available Memory');
      expect(md).toContain('- /conventions/commits.md (global, id: mem-abc)');
      expect(md).toContain('- /patterns/auth-flow.md (profile, id: mem-def)');
      expect(md).toContain('memory_read');
      expect(md).toContain('memory_search');
      // Full content should NOT appear
      expect(md).not.toContain('This is the full content of the commits convention.');
      expect(md).not.toContain('Detailed auth flow documentation here.');
    });

    it('shows omitted count when memories exceed MAX_MEMORY_INDEX_ENTRIES', () => {
      const memories: MemoryEntry[] = Array.from({ length: 105 }, (_, i) =>
        makeMemory({
          id: `mem-${i}`,
          path: `/entry-${i}.md`,
          updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        }),
      );

      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        { memories },
      );

      expect(md).toContain('## Available Memory');
      expect(md).toContain('5 more available');
      expect(md).toContain('memory_search');
      // Should not contain all 105 entries
      const entryLines = md.split('\n').filter((l) => l.startsWith('- /entry-'));
      expect(entryLines).toHaveLength(100);
    });

    it('does not show omitted note when memories fit within limit', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          memories: [makeMemory({ id: 'mem1', path: '/one.md' })],
        },
      );

      expect(md).toContain('## Available Memory');
      expect(md).not.toContain('more available');
    });
  });

  describe('sortMemoriesForIndex', () => {
    function makeMemory(overrides: Partial<MemoryEntry>): MemoryEntry {
      return {
        id: 'mem1',
        scope: 'global',
        scopeId: null,
        path: '/test.md',
        content: '',
        contentSha256: '',
        version: 1,
        approved: true,
        createdByPodId: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('orders pod before profile before global', () => {
      const memories = [
        makeMemory({ id: 'g', scope: 'global', updatedAt: '2026-03-01T00:00:00Z' }),
        makeMemory({ id: 'p', scope: 'profile', updatedAt: '2026-01-01T00:00:00Z' }),
        makeMemory({ id: 's', scope: 'pod', updatedAt: '2026-01-01T00:00:00Z' }),
      ];

      const sorted = sortMemoriesForIndex(memories);
      expect(sorted.map((m) => m.id)).toEqual(['s', 'p', 'g']);
    });

    it('sorts by updatedAt descending within same scope', () => {
      const memories = [
        makeMemory({ id: 'old', scope: 'profile', updatedAt: '2026-01-01T00:00:00Z' }),
        makeMemory({ id: 'new', scope: 'profile', updatedAt: '2026-06-01T00:00:00Z' }),
        makeMemory({ id: 'mid', scope: 'profile', updatedAt: '2026-03-01T00:00:00Z' }),
      ];

      const sorted = sortMemoriesForIndex(memories);
      expect(sorted.map((m) => m.id)).toEqual(['new', 'mid', 'old']);
    });

    it('does not mutate the original array', () => {
      const memories = [
        makeMemory({ id: 'g', scope: 'global' }),
        makeMemory({ id: 's', scope: 'pod' }),
      ];

      sortMemoriesForIndex(memories);
      expect(memories[0].id).toBe('g');
    });
  });
});
