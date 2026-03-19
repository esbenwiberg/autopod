import { describe, it, expect, vi } from 'vitest';
import type { Session, ValidationResult, Profile } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/index.js';
import {
  buildCorrectionContext,
  buildCorrectionMessage,
  determineFailedStep,
  truncateDiff,
} from './correction-context.js';

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    profileName: 'test-app',
    task: 'Add a contact page',
    status: 'validating',
    model: 'opus',
    runtime: 'claude',
    branch: 'autopod/sess-1',
    containerId: 'ctr-abc',
    worktreePath: '/tmp/worktree/sess-1',
    validationAttempts: 1,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    updatedAt: new Date().toISOString(),
    userId: 'user-1',
    filesChanged: 3,
    linesAdded: 50,
    linesRemoved: 10,
    previewUrl: 'http://localhost:3000',
    ...overrides,
  };
}

function mockProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-app',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 120,
    validationPages: [],
    maxValidationAttempts: 3,
    defaultModel: 'opus',
    defaultRuntime: 'claude',
    customInstructions: null,
    escalation: { askHuman: true, askAi: { enabled: true, model: 'sonnet', maxCalls: 5 }, autoPauseAfter: 3, humanResponseTimeout: 3600 },
    extends: null,
    warmImageTag: null,
    warmImageBuiltAt: null,
    mcpServers: [],
    claudeMdSections: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockValidationResult(overrides: {
  buildFailed?: boolean;
  healthFailed?: boolean;
  pageFailed?: boolean;
  taskReviewFailed?: boolean;
  issues?: string[];
} = {}): ValidationResult {
  return {
    sessionId: 'sess-1',
    attempt: 1,
    timestamp: new Date().toISOString(),
    smoke: {
      status: overrides.buildFailed || overrides.healthFailed || overrides.pageFailed ? 'fail' : 'pass',
      build: {
        status: overrides.buildFailed ? 'fail' : 'pass',
        output: overrides.buildFailed ? 'Build error' : '',
        duration: 100,
      },
      health: {
        status: overrides.healthFailed ? 'fail' : 'pass',
        url: 'http://localhost:3000/health',
        responseCode: overrides.healthFailed ? null : 200,
        duration: 50,
      },
      pages: overrides.pageFailed
        ? [{ path: '/', status: 'fail' as const, screenshotPath: '', consoleErrors: [], assertions: [], loadTime: 100 }]
        : [],
    },
    taskReview: overrides.taskReviewFailed
      ? {
          status: 'fail',
          reasoning: 'Does not match requirements',
          issues: overrides.issues ?? ['Missing feature'],
          model: 'opus',
          screenshots: [],
          diff: '',
        }
      : null,
    overall: 'fail',
    duration: 5000,
  };
}

function mockContainerManager(diff = '+added line\n-removed line'): ContainerManager {
  return {
    spawn: vi.fn(),
    kill: vi.fn(),
    writeFile: vi.fn(),
    getStatus: vi.fn(),
    execInContainer: vi.fn().mockResolvedValue({ stdout: diff, stderr: '', exitCode: 0 }),
  };
}

describe('determineFailedStep', () => {
  it('returns build when build fails', () => {
    expect(determineFailedStep(mockValidationResult({ buildFailed: true }))).toBe('build');
  });

  it('returns health when health fails (build passes)', () => {
    expect(determineFailedStep(mockValidationResult({ healthFailed: true }))).toBe('health');
  });

  it('returns smoke when page fails (build and health pass)', () => {
    expect(determineFailedStep(mockValidationResult({ pageFailed: true }))).toBe('smoke');
  });

  it('returns task_review when everything else passes', () => {
    expect(determineFailedStep(mockValidationResult({ taskReviewFailed: true }))).toBe('task_review');
  });

  it('prioritizes build over health', () => {
    expect(determineFailedStep(mockValidationResult({ buildFailed: true, healthFailed: true }))).toBe('build');
  });
});

describe('truncateDiff', () => {
  it('returns short diffs unchanged', () => {
    const diff = '+added\n-removed';
    expect(truncateDiff(diff, 50_000)).toBe(diff);
  });

  it('truncates long diffs', () => {
    const longDiff = 'a'.repeat(100_000);
    const truncated = truncateDiff(longDiff, 50_000);
    expect(truncated.length).toBeLessThanOrEqual(50_020);
    expect(truncated).toContain('truncated');
  });

  it('returns empty string unchanged', () => {
    expect(truncateDiff('', 50_000)).toBe('');
  });
});

describe('buildCorrectionContext', () => {
  it('includes previous diff from container', async () => {
    const cm = mockContainerManager('+added line\n-removed line');
    const context = await buildCorrectionContext(
      mockSession(), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(context.previousDiff).toContain('+added line');
    expect(cm.execInContainer).toHaveBeenCalledWith(
      'ctr-abc',
      ['git', 'diff', 'HEAD~1'],
      { cwd: '/tmp/worktree/sess-1' },
    );
  });

  it('handles missing containerId gracefully', async () => {
    const cm = mockContainerManager();
    const context = await buildCorrectionContext(
      mockSession({ containerId: null }), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(context.previousDiff).toBe('');
    expect(cm.execInContainer).not.toHaveBeenCalled();
  });

  it('includes screenshot descriptions from task review', async () => {
    const cm = mockContainerManager();
    const context = await buildCorrectionContext(
      mockSession(),
      mockProfile(),
      mockValidationResult({ taskReviewFailed: true, issues: ['Missing nav', 'Wrong color'] }),
      cm,
    );
    expect(context.screenshotDescriptions).toEqual(['Missing nav', 'Wrong color']);
  });

  it('sets empty screenshot descriptions when no task review failure', async () => {
    const cm = mockContainerManager();
    const context = await buildCorrectionContext(
      mockSession(), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(context.screenshotDescriptions).toEqual([]);
  });

  it('handles exec error gracefully', async () => {
    const cm = mockContainerManager();
    (cm.execInContainer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no commits'));
    const context = await buildCorrectionContext(
      mockSession(), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(context.previousDiff).toBe('');
  });
});

describe('buildCorrectionMessage', () => {
  it('includes validation feedback', async () => {
    const cm = mockContainerManager('');
    const message = await buildCorrectionMessage(
      mockSession(), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(message).toContain('Validation Failed');
    expect(message).toContain('Build Errors');
  });

  it('includes diff context when available', async () => {
    const cm = mockContainerManager('+const x = 1;');
    const message = await buildCorrectionMessage(
      mockSession(), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(message).toContain('Your Changes So Far');
    expect(message).toContain('+const x = 1;');
  });

  it('includes custom instructions when profile has them', async () => {
    const cm = mockContainerManager('');
    const message = await buildCorrectionMessage(
      mockSession(),
      mockProfile({ customInstructions: 'Always use TypeScript strict mode' }),
      mockValidationResult({ buildFailed: true }),
      cm,
    );
    expect(message).toContain('Project Instructions (reminder)');
    expect(message).toContain('TypeScript strict mode');
  });

  it('omits diff section when diff is empty', async () => {
    const cm = mockContainerManager('');
    const message = await buildCorrectionMessage(
      mockSession(), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(message).not.toContain('Your Changes So Far');
  });

  it('omits instructions section when profile has none', async () => {
    const cm = mockContainerManager('');
    const message = await buildCorrectionMessage(
      mockSession(), mockProfile(), mockValidationResult({ buildFailed: true }), cm,
    );
    expect(message).not.toContain('Project Instructions');
  });
});
