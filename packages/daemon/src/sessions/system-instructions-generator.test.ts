import type { Profile, Session } from '@autopod/shared';
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
    escalation: {
      askHuman: true,
      askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSession(overrides?: Partial<Session>): Session {
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
    ...overrides,
  };
}

describe('generateSystemInstructions', () => {
  it('includes session id, profile, and task', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession(),
      'http://localhost:8080/mcp/abc12345',
    );

    expect(md).toContain('Session ID: abc12345');
    expect(md).toContain('Profile: test-profile');
    expect(md).toContain('Task: Add dark mode');
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

  it('includes acceptance criteria when session has ACs', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        acceptanceCriteria: [
          'Settings page has a dark mode toggle',
          'Toggle persists after refresh',
        ],
      }),
      'http://localhost:8080/mcp/x',
    );
    expect(md).toContain('## Acceptance Criteria');
    expect(md).toContain('- Settings page has a dark mode toggle');
    expect(md).toContain('- Toggle persists after refresh');
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

  it('includes self-validation section when session has acceptance criteria', () => {
    const md = generateSystemInstructions(
      makeProfile(),
      makeSession({
        acceptanceCriteria: ['Page loads without errors'],
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
    expect(md).toContain('Make small, focused commits');
    expect(md).toContain('Do NOT modify configuration files');
  });

  it('includes injected skills section with descriptions', () => {
    const md = generateSystemInstructions(makeProfile(), makeSession(), 'http://localhost:8080/mcp/x', {
      injectedSkills: [
        { name: 'review', source: { type: 'local', path: '/s/r.md' }, description: 'Review PR changes' },
        { name: 'deploy', source: { type: 'github', repo: 'org/skills' } },
      ],
    });

    expect(md).toContain('## Available Skills');
    expect(md).toContain('`/review` — Review PR changes');
    expect(md).toContain('`/deploy`');
    // deploy has no description so no dash after it
    expect(md).not.toContain('`/deploy` —');
  });

  it('omits skills section when no skills injected', () => {
    const md = generateSystemInstructions(makeProfile(), makeSession(), 'http://localhost:8080/mcp/x');
    expect(md).not.toContain('## Available Skills');
  });
});
