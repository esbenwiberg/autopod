import type { Pod, Profile, ValidationResult } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/index.js';
import {
  buildCorrectionContext,
  buildCorrectionMessage,
  determineFailedStep,
  isCapsuleCoverageFailure,
  truncateDiff,
} from './correction-context.js';

function mockSession(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'sess-1',
    profileName: 'test-app',
    task: 'Add a contact page',
    status: 'validating',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'local',
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
    prUrl: null,
    plan: null,
    progress: null,
    claudeSessionId: null,
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
    networkPolicy: null,
    actionPolicy: null,
    outputMode: 'pr' as const,
    modelProvider: 'anthropic' as const,
    providerCredentials: null,
    testCommand: null,
    prProvider: 'github' as const,
    adoPat: null,
    skills: [],
    privateRegistries: [],
    registryPat: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockValidationResult(
  overrides: {
    lintFailed?: boolean;
    sastFailed?: boolean;
    buildFailed?: boolean;
    setupFailed?: boolean;
    testsFailed?: boolean;
    healthFailed?: boolean;
    pageFailed?: boolean;
    taskReviewFailed?: boolean;
    issues?: string[];
  } = {},
): ValidationResult {
  return {
    podId: 'sess-1',
    attempt: 1,
    timestamp: new Date().toISOString(),
    setup: overrides.setupFailed
      ? { status: 'fail', output: 'pip install failed', duration: 25 }
      : { status: 'skip', output: '', duration: 0 },
    smoke: {
      status:
        overrides.setupFailed ||
        overrides.buildFailed ||
        overrides.healthFailed ||
        overrides.pageFailed
          ? 'fail'
          : 'pass',
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
        ? [
            {
              path: '/',
              status: 'fail' as const,
              screenshotPath: '',
              consoleErrors: [],
              assertions: [],
              loadTime: 100,
            },
          ]
        : [],
    },
    test: overrides.testsFailed
      ? { status: 'fail', duration: 1500, stdout: 'expected 1 to equal 2', stderr: '' }
      : { status: 'skip', duration: 0 },
    lint: overrides.lintFailed
      ? { status: 'fail', output: 'Linting errors found', duration: 50 }
      : { status: 'skip', output: '', duration: 0 },
    sast: overrides.sastFailed
      ? { status: 'fail', output: 'High severity finding', duration: 50 }
      : { status: 'skip', output: '', duration: 0 },
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
    stop: vi.fn(),
    start: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn().mockResolvedValue(''),
    getStatus: vi.fn(),
    execInContainer: vi.fn().mockResolvedValue({ stdout: diff, stderr: '', exitCode: 0 }),
    execStreaming: vi.fn(),
  };
}

describe('determineFailedStep', () => {
  it('returns setup when setup fails', () => {
    expect(determineFailedStep(mockValidationResult({ setupFailed: true }))).toBe('setup');
  });

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
    expect(determineFailedStep(mockValidationResult({ taskReviewFailed: true }))).toBe(
      'task_review',
    );
  });

  it('prioritizes build over health', () => {
    expect(
      determineFailedStep(mockValidationResult({ buildFailed: true, healthFailed: true })),
    ).toBe('build');
  });

  it('returns lint when lint fails', () => {
    expect(determineFailedStep(mockValidationResult({ lintFailed: true }))).toBe('lint');
  });

  it('returns sast when sast fails (lint passes)', () => {
    expect(determineFailedStep(mockValidationResult({ sastFailed: true }))).toBe('sast');
  });

  it('returns tests when test phase fails (build passes)', () => {
    expect(determineFailedStep(mockValidationResult({ testsFailed: true }))).toBe('tests');
  });

  it('prioritizes lint over everything else', () => {
    expect(
      determineFailedStep(
        mockValidationResult({ lintFailed: true, sastFailed: true, buildFailed: true }),
      ),
    ).toBe('lint');
  });

  it('prioritizes setup over downstream failures', () => {
    expect(
      determineFailedStep(
        mockValidationResult({ setupFailed: true, lintFailed: true, buildFailed: true }),
      ),
    ).toBe('setup');
  });

  it('prioritizes build over tests', () => {
    expect(
      determineFailedStep(mockValidationResult({ buildFailed: true, testsFailed: true })),
    ).toBe('build');
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

describe('isCapsuleCoverageFailure', () => {
  it('detects capsule coverage lint output', () => {
    const result = mockValidationResult({ lintFailed: true });
    result.lint = {
      status: 'fail',
      output:
        'capsule check failed\nnon-capsule commits not covered by capsule commit_range: abc123',
      duration: 50,
    };

    expect(isCapsuleCoverageFailure(result)).toBe(true);
  });

  it('ignores ordinary lint failures', () => {
    expect(isCapsuleCoverageFailure(mockValidationResult({ lintFailed: true }))).toBe(false);
  });
});

describe('buildCorrectionContext', () => {
  it('includes previous diff from container', async () => {
    const cm = mockContainerManager('+added line\n-removed line');
    const context = await buildCorrectionContext(
      mockSession(),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
    );
    expect(context.previousDiff).toContain('+added line');
    expect(cm.execInContainer).toHaveBeenCalledWith('ctr-abc', ['git', 'diff', 'HEAD~1'], {
      cwd: '/workspace',
    });
  });

  it('handles missing containerId gracefully', async () => {
    const cm = mockContainerManager();
    const context = await buildCorrectionContext(
      mockSession({ containerId: null }),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
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
      mockSession(),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
    );
    expect(context.screenshotDescriptions).toEqual([]);
  });

  it('includes test/lint/sast failures in screenshot descriptions', async () => {
    const cm = mockContainerManager();
    const result = mockValidationResult({
      lintFailed: true,
      sastFailed: true,
      testsFailed: true,
    });
    const context = await buildCorrectionContext(mockSession(), mockProfile(), result, cm);
    expect(context.screenshotDescriptions).toContainEqual(expect.stringContaining('Lint failed'));
    expect(context.screenshotDescriptions).toContainEqual(
      expect.stringContaining('Security scan failed'),
    );
    expect(context.screenshotDescriptions).toContainEqual(expect.stringContaining('Tests failed'));
  });

  it('handles exec error gracefully', async () => {
    const cm = mockContainerManager();
    (cm.execInContainer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no commits'));
    const context = await buildCorrectionContext(
      mockSession(),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
    );
    expect(context.previousDiff).toBe('');
  });
});

describe('buildCorrectionMessage', () => {
  it('includes validation feedback', async () => {
    const cm = mockContainerManager('');
    const message = await buildCorrectionMessage(
      mockSession(),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
    );
    expect(message).toContain('Validation Failed');
    expect(message).toContain('Build Errors');
  });

  it('includes diff context when available', async () => {
    const cm = mockContainerManager('+const x = 1;');
    const message = await buildCorrectionMessage(
      mockSession(),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
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

  it('adds targeted guidance for capsule coverage lint failures', async () => {
    const cm = mockContainerManager('');
    const result = mockValidationResult({ lintFailed: true });
    result.lint = {
      status: 'fail',
      output:
        'capsule check failed\nnon-capsule commits not covered by capsule commit_range: abc123',
      duration: 50,
    };

    const message = await buildCorrectionMessage(mockSession(), mockProfile(), result, cm);

    expect(message).toContain('Capsule Coverage Guidance');
    expect(message).toContain('Extend the relevant capsule `commit_range`');
    expect(message).toContain('Do not archive, move, or rename parent/previous capsules');
  });

  it('omits diff section when diff is empty', async () => {
    const cm = mockContainerManager('');
    const message = await buildCorrectionMessage(
      mockSession(),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
    );
    expect(message).not.toContain('Your Changes So Far');
  });

  it('omits instructions section when profile has none', async () => {
    const cm = mockContainerManager('');
    const message = await buildCorrectionMessage(
      mockSession(),
      mockProfile(),
      mockValidationResult({ buildFailed: true }),
      cm,
    );
    expect(message).not.toContain('Project Instructions');
  });
});
