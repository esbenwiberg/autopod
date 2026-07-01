import type { Pod, ReadinessReview, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import type { StoredScan } from '../security/scan-repository.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import {
  type ReadinessInputs,
  createReadinessService,
  deriveReadinessReview,
  deriveSeriesReadiness,
} from './readiness-review.js';
import type { ValidationRepository } from './validation-repository.js';

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

  it('keeps known tool egress info-only when every denied host is non-blocking', () => {
    const result = review({
      deniedEgressCount: 3,
      nonBlockingDeniedEgressCount: 3,
    });

    expect(result.status).toBe('ready');
    expect(result.areas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: 'network',
          status: 'ready',
          summary: '3 known tool egress event(s) blocked; no review needed.',
        }),
      ]),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: 'network-known-tool-egress',
        area: 'network',
        severity: 'info',
      }),
    ]);
  });

  it('keeps known tool egress non-blocking but flags unknown denied egress', () => {
    const result = review({
      deniedEgressCount: 5,
      nonBlockingDeniedEgressCount: 3,
    });

    expect(result.status).toBe('needs_review');
    expect(result.summary).toBe('1 finding(s) need operator review.');
    expect(result.areas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: 'network',
          status: 'needs_review',
          summary: '2 denied egress event(s) need review; 3 known tool event(s) recorded.',
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'network-denied-egress', severity: 'warning' }),
        expect.objectContaining({ id: 'network-known-tool-egress', severity: 'info' }),
      ]),
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

  it('marks force-approve paths without passing validation proof as waived', () => {
    const result = review({
      pod: pod({ lastCorrectionMessage: '[FORCE APPROVED] accepted by operator' }),
      latestValidation: null,
    });

    expect(result.status).toBe('waived');
    expect(result.areas).toEqual(
      expect.arrayContaining([expect.objectContaining({ area: 'validation', status: 'waived' })]),
    );
  });

  it('does not mark force-approved pods as validation-waived when blocking validation passed', () => {
    const result = review({
      pod: pod({ lastCorrectionMessage: '[FORCE APPROVED] accepted by operator' }),
      latestValidation: validation({ overall: 'pass' }),
    });

    expect(result.status).toBe('ready');
    expect(result.areas).toEqual(
      expect.arrayContaining([expect.objectContaining({ area: 'validation', status: 'ready' })]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'validation-waiver' })]),
    );
  });

  it('keeps waived pods waived with advisory in flight findings', () => {
    const result = review({
      pod: pod({ lastCorrectionMessage: '[FORCE APPROVED] accepted by operator' }),
      latestValidation: null,
      advisoryQaInFlight: true,
    });

    expect(result.status).toBe('waived');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'validation-waiver' }),
        expect.objectContaining({ id: 'advisory-qa-in-flight' }),
      ]),
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

  it('series rollup keeps missing member review ahead of waived members', () => {
    const waivedReview = review({
      pod: pod({
        id: 'pod-waived',
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

    const rollup = deriveSeriesReadiness(
      'series-1',
      [pod({ id: 'pod-waived', readinessReview: waivedReview }), pod({ id: 'pod-old' })],
      NOW,
    );

    expect(rollup.status).toBe('needs_review');
    expect(rollup.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'series:series-1:missing:pod-old' })]),
    );
  });
});

describe('createReadinessService', () => {
  it('scopes latest validation to the current rework, ignoring stale higher-numbered attempts', () => {
    // Rework 0 failed after many attempts (attempt 9); rework 1 passed on attempt 1.
    // Attempt numbers reset per rework, so the stale fail has a HIGHER attempt number
    // than the fresh pass. Readiness must reflect rework 1, not rework 0.
    const reworkedPod = pod({ reworkCount: 1, lastValidationResult: null });
    const podRepo = {
      getOrThrow: () => reworkedPod,
      update: () => undefined,
      getPodsBySeries: () => [],
    } as unknown as PodRepository;
    const validationRepo = {
      // Ordered as the repository returns them: (rework ASC, attempt ASC).
      getForSession: () => [
        {
          id: 'v-rework0-attempt9',
          podId: reworkedPod.id,
          attempt: 9,
          reworkCount: 0,
          result: validation({
            attempt: 9,
            smoke: { ...validation().smoke, status: 'fail' },
            overall: 'fail',
          }),
          createdAt: NOW,
        },
        {
          id: 'v-rework1-attempt1',
          podId: reworkedPod.id,
          attempt: 1,
          reworkCount: 1,
          result: validation({ attempt: 1, overall: 'pass' }),
          createdAt: NOW,
        },
      ],
    } as unknown as ValidationRepository;

    const service = createReadinessService({ podRepo, validationRepo });
    const result = service.computePodReadiness(reworkedPod.id);

    const validationArea = result.areas.find((a) => a.area === 'validation');
    expect(validationArea?.status).toBe('ready');
    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'validation-failed' })]),
    );
  });

  it('uses pod-row advisory QA when validation history lacks the deferred merge', () => {
    const podWithAdvisory = pod({
      lastValidationResult: validation({
        advisoryBrowserQa: {
          status: 'fail',
          reasoning: 'Deferred advisory concern.',
          observations: [],
          screenshots: [],
        },
      }),
    });
    const podRepo = {
      getOrThrow: () => podWithAdvisory,
      update: () => undefined,
      getPodsBySeries: () => [],
    } as unknown as PodRepository;
    const validationRepo = {
      getForSession: () => [
        {
          id: 'validation-1',
          podId: podWithAdvisory.id,
          attempt: 1,
          result: validation(),
          createdAt: NOW,
        },
      ],
    } as unknown as ValidationRepository;

    const service = createReadinessService({ podRepo, validationRepo });
    const result = service.computePodReadiness(podWithAdvisory.id);

    expect(result.status).toBe('needs_review');
    expect(result.areas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: 'advisory_qa', status: 'needs_review' }),
      ]),
    );
  });

  it('classifies known denied-egress hosts from stored firewall events as non-blocking', () => {
    const podWithEvents = pod({ lastValidationResult: validation() });
    const podRepo = {
      getOrThrow: () => podWithEvents,
      update: () => undefined,
      getPodsBySeries: () => [],
    } as unknown as PodRepository;
    const eventRepo = {
      countForSession: (_podId: string, type: string) => (type === 'pod.preflight_overlap' ? 0 : 0),
      getForSession: () => [
        {
          id: 1,
          podId: podWithEvents.id,
          type: 'pod.firewall_denied',
          payload: {
            type: 'pod.firewall_denied',
            timestamp: NOW,
            podId: podWithEvents.id,
            sni: 'telemetry.vercel.com',
            src: '172.19.0.2',
          },
          createdAt: NOW,
        },
        {
          id: 2,
          podId: podWithEvents.id,
          type: 'pod.firewall_denied',
          payload: {
            type: 'pod.firewall_denied',
            timestamp: NOW,
            podId: podWithEvents.id,
            sni: 'ORAIOS-SOFTWARE.DE.',
            src: '172.26.0.2',
          },
          createdAt: NOW,
        },
      ],
    } as unknown as EventRepository;

    const service = createReadinessService({ podRepo, eventRepo });
    const result = service.computePodReadiness(podWithEvents.id);

    expect(result.status).toBe('ready');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'network-known-tool-egress', severity: 'info' }),
      ]),
    );
  });

  it('treats Chromium google.com startup probes as non-blocking denied egress', () => {
    const podWithEvents = pod({ lastValidationResult: validation() });
    const podRepo = {
      getOrThrow: () => podWithEvents,
      update: () => undefined,
      getPodsBySeries: () => [],
    } as unknown as PodRepository;
    const eventRepo = {
      countForSession: () => 0,
      getForSession: () =>
        ['www.google.com', 'accounts.google.com', 'www.google.com'].map((sni, index) => ({
          id: index + 1,
          podId: podWithEvents.id,
          type: 'pod.firewall_denied',
          payload: {
            type: 'pod.firewall_denied',
            timestamp: NOW,
            podId: podWithEvents.id,
            sni,
            src: '172.24.0.2',
          },
          createdAt: NOW,
        })),
    } as unknown as EventRepository;

    const service = createReadinessService({ podRepo, eventRepo });
    const result = service.computePodReadiness(podWithEvents.id);

    expect(result.status).toBe('ready');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'network-known-tool-egress', severity: 'info' }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'network-denied-egress', severity: 'warning' }),
      ]),
    );
  });
});
