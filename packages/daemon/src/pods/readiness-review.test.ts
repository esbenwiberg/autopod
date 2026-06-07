import type { Pod, ReadinessReview, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import type { StoredScan } from '../security/scan-repository.js';
import {
  type ReadinessInputs,
  deriveReadinessReview,
  deriveSeriesReadiness,
} from './readiness-review.js';

const NOW = '2026-06-07T00:00:00.000Z';

function pod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'pod-1',
    profileName: 'profile',
    task: 'task',
    status: 'validated',
    model: 'model',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'feature/pod-1',
    containerId: null,
    worktreePath: '/tmp/worktree',
    validationAttempts: 1,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    lastValidationFindings: null,
    lastCorrectionMessage: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: NOW,
    startedAt: NOW,
    runningAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    userId: 'user',
    creatorEmail: null,
    creatorName: null,
    filesChanged: 1,
    linesAdded: 1,
    linesRemoved: 0,
    previewUrl: null,
    hasWebUi: true,
    prUrl: 'https://example.test/pr/1',
    mergeBlockReason: null,
    plan: null,
    progress: null,
    contract: null,
    claudeSessionId: null,
    codexSessionId: null,
    options: { agentMode: 'auto', output: 'pr', validate: true, promotable: false },
    outputMode: 'pr',
    startBranch: null,
    baseBranch: 'main',
    specFiles: null,
    recoveryWorktreePath: null,
    reworkReason: null,
    reworkCount: 0,
    recoveryCount: 0,
    lastHeartbeatAt: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    commitCount: 1,
    lastCommitAt: NOW,
    startCommitSha: 'abc',
    linkedPodId: null,
    taskSummary: null,
    preSubmitReview: null,
    validationOverrides: null,
    validationWaiver: null,
    readinessReview: null,
    pimGroups: null,
    profileSnapshot: null,
    prFixAttempts: 0,
    maxPrFixAttempts: 3,
    fixPodId: null,
    fixIteration: 0,
    tokenBudget: null,
    budgetExtensionsUsed: 0,
    pauseReason: null,
    referenceRepos: null,
    artifactsPath: null,
    handoffInstructions: null,
    handoffContext: null,
    scheduledJobId: null,
    dependsOnPodIds: [],
    dependsOnPodId: null,
    seriesId: null,
    seriesName: null,
    seriesDescription: null,
    seriesDesign: null,
    briefTitle: null,
    touches: null,
    doesNotTouch: null,
    prMode: null,
    dependencyStartedAt: null,
    waitForMerge: false,
    autoApprove: false,
    disableAskHuman: false,
    requireSidecars: [],
    sidecarContainerIds: null,
    testRunBranches: null,
    worktreeCompromised: false,
    forceCompletedAt: null,
    forceCompletedReason: null,
    lastAgentEventAt: null,
    kickedAt: null,
    kickedReason: null,
    skipAgent: false,
    deployBaselineHashes: null,
    phaseTokenUsage: null,
    networkPolicyResolved: null,
    lastRecoveryTrigger: null,
    ...overrides,
  };
}

function validation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    podId: 'pod-1',
    attempt: 1,
    timestamp: NOW,
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: 'http://localhost', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 1,
    ...overrides,
  };
}

function scan(overrides: Partial<StoredScan> = {}): StoredScan {
  return {
    id: 'scan-1',
    podId: 'pod-1',
    checkpoint: 'push',
    decision: 'pass',
    startedAt: 1,
    completedAt: 2,
    filesScanned: 1,
    filesSkipped: 0,
    scanIncomplete: false,
    findings: [],
    ...overrides,
  };
}

function review(overrides: Partial<ReadinessInputs> = {}): ReadinessReview {
  return deriveReadinessReview({
    pod: pod(),
    latestValidation: validation(),
    actionAudit: {
      valid: true,
      rowCount: 0,
      quarantineCount: 0,
      piiCount: 0,
      piiCategories: [],
      maxQuarantineScore: 0,
    },
    deniedEgressCount: 0,
    preflightOverlapCount: 0,
    latestSecurityScan: scan(),
    qualityScore: 90,
    computedAt: NOW,
    ...overrides,
  });
}

describe('deriveReadinessReview', () => {
  it('marks a clean pod ready', () => {
    const result = review();

    expect(result.status).toBe('ready');
    expect(result.findings).toEqual([]);
    expect(
      result.areas
        .filter((area) => area.status !== 'not_applicable')
        .every((area) => area.status === 'ready'),
    ).toBe(true);
  });

  it.each([
    ['security warn', { latestSecurityScan: scan({ decision: 'warn' }) }, 'security'],
    ['scanner error fail-open', { latestSecurityScan: scan({ scanIncomplete: true }) }, 'security'],
    ['denied egress', { deniedEgressCount: 2 }, 'network'],
    ['scope overlap', { preflightOverlapCount: 1 }, 'scope'],
    [
      'action quarantine',
      {
        actionAudit: {
          valid: true,
          rowCount: 1,
          quarantineCount: 1,
          piiCount: 0,
          piiCategories: [],
          maxQuarantineScore: 0.2,
        },
      },
      'actions',
    ],
    [
      'action PII',
      {
        actionAudit: {
          valid: true,
          rowCount: 1,
          quarantineCount: 0,
          piiCount: 1,
          piiCategories: ['email'],
          maxQuarantineScore: 0,
        },
      },
      'actions',
    ],
    ['low quality', { qualityScore: 40 }, 'quality'],
    [
      'advisory concern',
      {
        latestValidation: validation({
          advisoryBrowserQa: {
            status: 'fail',
            reasoning: 'Visual issue',
            observations: [],
            screenshots: [],
          },
        }),
      },
      'advisory_qa',
    ],
    ['advisory in flight', { advisoryQaInFlight: true }, 'advisory_qa'],
  ] as const)('marks %s as needs_review', (_name, overrides, area) => {
    const result = review(overrides);

    expect(result.status).toBe('needs_review');
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ area, severity: 'warning' })]),
    );
  });

  it.each([
    ['failed validation', { latestValidation: validation({ overall: 'fail' }) }, 'validation'],
    ['unknown validation', { latestValidation: null }, 'validation'],
    [
      'invalid action chain',
      {
        actionAudit: {
          valid: false,
          rowCount: 1,
          reason: 'hash mismatch',
          quarantineCount: 0,
          piiCount: 0,
          piiCategories: [],
          maxQuarantineScore: 0,
        },
      },
      'actions',
    ],
    ['compromised worktree', { pod: pod({ worktreeCompromised: true }) }, 'scope'],
    ['blocked PR gate', { pod: pod({ mergeBlockReason: 'CI failed' }) }, 'pr'],
  ] as const)('marks %s as risky', (_name, overrides, area) => {
    const result = review(overrides);

    expect(result.status).toBe('risky');
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ area, severity: 'error' })]),
    );
  });

  it('marks waiver paths waived unless a separate hard risk exists', () => {
    const waived = review({
      pod: pod({
        validationWaiver: {
          waivedAt: NOW,
          waivedBy: 'human',
          reason: 'accepted',
          attempt: 1,
          failedPhases: ['review'],
          failedFactIds: [],
        },
      }),
    });

    expect(waived.status).toBe('waived');
    expect(waived.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'validation-waiver' })]),
    );

    const risky = review({
      pod: pod({
        mergeBlockReason: 'CI failed',
        validationWaiver: {
          waivedAt: NOW,
          waivedBy: 'human',
          reason: 'accepted',
          attempt: 1,
          failedPhases: ['review'],
          failedFactIds: [],
        },
      }),
    });

    expect(risky.status).toBe('risky');
    expect(risky.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'validation-waiver' }),
        expect.objectContaining({ id: 'pr-blocked' }),
      ]),
    );
  });

  it('marks force-approve paths as waived', () => {
    const result = review({
      pod: pod({ lastCorrectionMessage: '[FORCE APPROVED] accepted by operator' }),
    });

    expect(result.status).toBe('waived');
    expect(result.areas).toEqual(
      expect.arrayContaining([expect.objectContaining({ area: 'validation', status: 'waived' })]),
    );
  });
});

describe('deriveSeriesReadiness', () => {
  it('series rollup uses member snapshots and missing snapshots', () => {
    const readyReview = review({ pod: pod({ id: 'pod-ready' }) });
    const needsReview = review({ pod: pod({ id: 'pod-review' }), deniedEgressCount: 1 });
    const risky = review({ pod: pod({ id: 'pod-risky', mergeBlockReason: 'CI failed' }) });
    const rollup = deriveSeriesReadiness(
      'series-1',
      [
        pod({ id: 'pod-ready', readinessReview: readyReview }),
        pod({ id: 'pod-review', readinessReview: needsReview }),
        pod({ id: 'pod-risky', readinessReview: risky }),
        pod({ id: 'pod-old', readinessReview: null }),
      ],
      NOW,
    );

    expect(rollup.status).toBe('risky');
    expect(rollup.memberStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ podId: 'pod-old', status: 'not_available' }),
        expect.objectContaining({ podId: 'pod-risky', status: 'risky' }),
      ]),
    );
    expect(rollup.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'series:series-1:missing:pod-old',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('series rollup treats missing old snapshots as needs_review', () => {
    const rollup = deriveSeriesReadiness('series-1', [pod({ id: 'pod-old' })], NOW);

    expect(rollup.status).toBe('needs_review');
    expect(rollup.findings[0]).toMatchObject({
      title: 'Member readiness unavailable',
      severity: 'warning',
    });
  });
});
