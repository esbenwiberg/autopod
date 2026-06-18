import type { MemoryEntry, Pod, Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { generateSystemInstructions } from './system-instructions-generator.js';

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
    agentDonePrompt: null,
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

  it('includes runtime-only spec context instructions when specContextFiles exist', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        specContextFiles: [{ path: 'specs/demo/plan.md', content: '# Plan\n' }],
      }),
      'http://localhost:8080/mcp/abc12345',
    );

    expect(md).toContain('## Spec Context');
    expect(md).toContain('`/autopod/spec/`');
    expect(md).toContain('do not copy or commit');
  });

  it('uses ephemeral artifact handovers for series pods', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        id: 'child-1',
        seriesId: 'demo-series',
        seriesName: 'Demo Series',
        dependsOnPodIds: ['parent-a', 'parent-b'],
      }),
      'http://localhost:8080/mcp/child-1',
    );

    expect(md).toContain('/autopod/artifacts/handovers/parent-a.md');
    expect(md).toContain('/autopod/artifacts/handovers/parent-b.md');
    expect(md).toContain('/autopod/artifacts/handovers/child-1.md');
    expect(md).toContain('Do not commit runtime handovers');
    expect(md).not.toContain('specs/demo-series/handovers');
  });

  it('includes profile finish prompt before report_task_summary when configured', () => {
    const md = generateSystemInstructions(
      makeProfile({
        agentDonePrompt: 'If clawpatch.ai is available in this repo, run it and address findings.',
      }),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    const promptIndex = md.indexOf('<!-- BEGIN PROFILE AGENT DONE PROMPT -->');
    const summaryIndex = md.indexOf('Summarise before finishing');
    expect(promptIndex).toBeGreaterThan(0);
    expect(summaryIndex).toBeGreaterThan(promptIndex);
    expect(md).toContain('If clawpatch.ai is available in this repo, run it and address findings.');
  });

  it('omits profile finish prompt when not configured', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).not.toContain('PROFILE AGENT DONE PROMPT');
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
    // Consolidated first-turn block appears before the per-server section
    expect(md).toContain('**On your first turn, load all tool schemas before starting work:**');
    // Both the consolidated block and the per-server reminder reference the tool names
    expect(md).toContain(
      'ToolSearch select:mcp__serena__find_symbol,mcp__serena__find_referencing_symbols',
    );
    // Per-server line uses "Load schemas:" not "First turn:"
    expect(md).toContain(
      'Load schemas: `ToolSearch select:mcp__serena__find_symbol,mcp__serena__find_referencing_symbols`',
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

  it('renders Code Navigation Rules when serena is injected', () => {
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
            toolNames: ['mcp__serena__find_symbol'],
          },
        ],
      },
    );

    expect(md).toContain('## Code Navigation Rules');
    expect(md).toContain(
      'Use them for symbol navigation, references, implementations, type hierarchy, and code exploration.',
    );
    expect(md).toContain('use built-in `Edit`, `MultiEdit`, or `Write` for simple literal changes');
    expect(md).toContain(
      'Use a semantic MCP refactor or rename tool only when the loaded schema explicitly offers one',
    );
    expect(md).toContain('Do not use Serena `replace_content` for routine text edits');
    expect(md).toContain('mcp__serena__find_symbol');
    expect(md).toContain('mcp__serena__find_referencing_symbols');
    // roslyn rows must be absent when only serena is active
    expect(md).not.toContain('mcp__roslyn-codelens__find_implementations');
    // Section appears before Operating Environment
    expect(md.indexOf('## Code Navigation Rules')).toBeLessThan(
      md.indexOf('## Operating Environment'),
    );
  });

  it('renders Code Navigation Rules with roslyn rows when roslyn-codelens is injected', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
      {
        injectedMcpServers: [
          {
            type: 'stdio',
            name: 'roslyn-codelens',
            command: 'roslyn-codelens-mcp',
            toolNames: ['mcp__roslyn-codelens__find_implementations'],
          },
        ],
      },
    );

    expect(md).toContain('## Code Navigation Rules');
    expect(md).toContain('mcp__roslyn-codelens__find_implementations');
    expect(md).toContain('mcp__roslyn-codelens__get_di_registrations');
    // serena rows must be absent when only roslyn is active
    expect(md).not.toContain('mcp__serena__find_symbol');
  });

  it('omits Code Navigation Rules when no code-intel servers are injected', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
      {
        injectedMcpServers: [
          {
            type: 'http',
            name: 'some-other-mcp',
            url: 'http://localhost:9000/mcp',
          },
        ],
      },
    );

    expect(md).not.toContain('## Code Navigation Rules');
  });

  it('omits Code Navigation Rules when no servers are injected', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Code Navigation Rules');
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

  it('renders ## Handoff section between brief and the rest when handoffContext is set', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        handoffContext:
          "You're picking up after a human-driven session.\n\n### Human instructions\nfinish wiring tab Y",
      }),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('## Handoff');
    expect(md).toContain('<!-- BEGIN HANDOFF CONTEXT -->');
    expect(md).toContain('<!-- END HANDOFF CONTEXT -->');
    expect(md).toContain('finish wiring tab Y');

    const briefIdx = md.indexOf('## Brief');
    const handoffIdx = md.indexOf('## Handoff');
    expect(briefIdx).toBeGreaterThan(-1);
    expect(handoffIdx).toBeGreaterThan(briefIdx);
  });

  it('omits ## Handoff section when handoffContext is null', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).not.toContain('## Handoff');
    expect(md).not.toContain('<!-- BEGIN HANDOFF CONTEXT -->');
  });

  it('includes validate_in_browser tool in MCP tools list', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );
    expect(md).toContain('validate_in_browser');
  });

  it('includes guidelines', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('## Guidelines');
    expect(md).toContain('Commit after every meaningful, reviewable unit of work');
    expect(md).toContain('Do NOT modify configuration files');
    expect(md).toContain('Self-review your diff');
  });

  it('lists configured pre-completion commands in guidelines', () => {
    const md = generateSystemInstructions(
      makeProfile({
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        lintCommand: 'biome check .',
      }),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('Run pre-completion checks before `report_task_summary`');
    expect(md).toContain('lint: `biome check .`');
    expect(md).toContain('build: `npm run build`');
    expect(md).toContain('tests: `npm test`');
  });

  it('mentions buildWorkDir when set so the agent runs commands in the right place', () => {
    const md = generateSystemInstructions(
      makeProfile({ buildCommand: 'npm run build', buildWorkDir: 'apps/web' }),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('run from `/workspace/apps/web`');
  });

  it('falls back to a generic build-passes hint when no commands are configured', () => {
    const md = generateSystemInstructions(
      makeProfile({ buildCommand: null, testCommand: null, lintCommand: null }),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('Ensure the build passes before completing');
    expect(md).not.toContain('Run pre-completion checks');
  });

  it('still tells the agent that validation also runs after finishing', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('Validation also runs after you finish');
    expect(md).not.toContain('Validation is automatic');
  });

  it('mentions pre_submit_review in guidelines', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/x',
    );

    expect(md).toContain('pre_submit_review');
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

    it('describes deploy coverage and surfaces env vars + allowedScripts when deploy group is enabled', () => {
      const md = generateSystemInstructions(
        makeProfile({
          deployment: {
            enabled: true,
            env: { ACR_NAME: 'myregistry', AZURE_RG: '$DAEMON:RG_NAME' },
            allowedScripts: ['infra/azure/acr-deploy.sh'],
          },
        }),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          availableActions: [
            {
              name: 'run_deploy_script',
              description: 'Run a deploy script',
              group: 'deploy',
              params: {
                script_path: { type: 'string', required: true, description: 'Path' },
              },
            },
          ],
        },
      );
      expect(md).toContain('Deployment scripts');
      expect(md).toContain('### Deployment — Pre-configured');
      expect(md).toContain('`ACR_NAME`');
      expect(md).toContain('`AZURE_RG`');
      expect(md).toContain('`infra/azure/acr-deploy.sh`');
      expect(md).toContain('do NOT try to read them from the container env');
    });

    it('omits deploy details section when deploy group is enabled but profile.deployment is not', () => {
      const md = generateSystemInstructions(
        makeProfile({ deployment: null }),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          availableActions: [
            {
              name: 'run_deploy_script',
              description: 'Run a deploy script',
              group: 'deploy',
              params: {
                script_path: { type: 'string', required: true, description: 'Path' },
              },
            },
          ],
        },
      );
      expect(md).toContain('Deployment scripts');
      expect(md).not.toContain('### Deployment — Pre-configured');
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

  describe('relevant memory', () => {
    function makeMemory(overrides: Partial<MemoryEntry>): MemoryEntry {
      return {
        id: 'mem1',
        scope: 'global',
        scopeId: null,
        path: '/conventions/test.md',
        content: 'Full content that should not appear in the index.',
        contentSha256: 'abc123',
        rationale: null,
        kind: null,
        tags: [],
        appliesWhen: null,
        avoidWhen: null,
        confidence: null,
        sourceEvidence: [],
        impactSummary: null,
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
      expect(md).not.toContain('## Relevant Memory');
    });

    it('omits memory section when relevantMemories is empty array', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        { relevantMemories: [] },
      );
      expect(md).not.toContain('## Relevant Memory');
    });

    it('renders selected memory content and reviewer rationale', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          relevantMemories: [
            {
              memory: makeMemory({
                id: 'mem-abc',
                scope: 'global',
                path: '/conventions/commits.md',
                content: 'This is the full content of the commits convention.',
              }),
              relevanceReason: 'The task changes commit generation.',
            },
            {
              memory: makeMemory({
                id: 'mem-def',
                scope: 'profile',
                scopeId: 'test-profile',
                path: '/patterns/auth-flow.md',
                content: 'Detailed auth flow documentation here.',
              }),
              relevanceReason: 'The requested auth work touches this flow.',
            },
          ],
        },
      );

      expect(md).toContain('## Relevant Memory');
      expect(md).not.toContain('## Available Memory');
      expect(md).toContain('### /conventions/commits.md');
      expect(md).toContain('- ID: mem-abc');
      expect(md).toContain('- Why this matters now: The task changes commit generation.');
      expect(md).toContain('This is the full content of the commits convention.');
      expect(md).toContain('Detailed auth flow documentation here.');
    });

    it('renders at most the already selected memories and no old omitted-count index', () => {
      const relevantMemories = Array.from({ length: 5 }, (_, i) => ({
        memory: makeMemory({
          id: `mem-${i}`,
          path: `/entry-${i}.md`,
          content: `Memory content ${i}`,
        }),
        relevanceReason: `Reason ${i}`,
      }));

      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        { relevantMemories },
      );

      expect(md).toContain('## Relevant Memory');
      expect(md).not.toContain('more available');
      const entryLines = md.split('\n').filter((l) => l.startsWith('- /entry-'));
      expect(entryLines).toHaveLength(0);
      const headings = md.split('\n').filter((l) => l.startsWith('### /entry-'));
      expect(headings).toHaveLength(5);
    });

    it('surfaces reviewer ranking fallback reasons', () => {
      const md = generateSystemInstructions(
        makeProfile(),
        makeSession(),
        'http://localhost:8080/mcp/x',
        {
          relevantMemories: [
            {
              memory: makeMemory({ id: 'mem1', path: '/one.md', content: 'Remember this.' }),
              relevanceReason: 'Reviewer ranking unavailable; deterministic fallback selected it.',
            },
          ],
          memoryUnavailableReason: 'reviewer_model_failed: timeout',
        },
      );

      expect(md).toContain('## Relevant Memory');
      expect(md).toContain('Reviewer ranking was unavailable (reviewer_model_failed: timeout)');
    });
  });
});
