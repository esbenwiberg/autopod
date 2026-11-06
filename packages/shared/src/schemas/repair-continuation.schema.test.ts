import { describe, expect, it } from 'vitest';
import {
  environmentQualificationBindingV1Schema,
  environmentQualificationEvidenceV1Schema,
  prerequisiteBlockerV1Schema,
  repairCodingFinalSourceV1Schema,
  repairContinuationContextPaths,
  repairContinuationExecutionModeSchema,
  repairContinuationInspectionV1Schema,
  repairContinuationOperationV1Schema,
  repairContinuationPreviewQueryV1Schema,
  repairContinuationPreviewV1Schema,
  repairContinuationRequestV1Schema,
} from './repair-continuation.schema.js';

const hash = 'a'.repeat(64);
const head = 'b'.repeat(40);
const request = {
  version: 1,
  intent: 'qualify_then_code_once',
  id: 'repair-1',
  expectedGeneration: 2,
  expectedResultHash: hash,
  expectedReportSetHash: hash,
  sourceHead: head,
  executionProfileId: 'replacement',
  expectedExecutionDigest: hash,
  expectedBindingDigest: hash,
  reason: 'Replace the missing declared launcher',
};
const source = { repository: 'https://github.com/org/repo', head, tree: head, baseCommitSha: head };
const binding = {
  version: 1,
  operationId: 'repair-1',
  requestHash: hash,
  podId: 'pod',
  taskId: 'task:1',
  executionId: 'execution:1',
  custodyId: 'custody',
  originalGeneration: 2,
  candidateGeneration: 3,
  originalResultHash: hash,
  reportSetHash: hash,
  requirementsHash: hash,
  originalLaunchDigest: hash,
  replacementLaunchDigest: hash,
  configurationHash: hash,
  sourceEpoch: hash,
  credentialEpoch: hash,
  resourceEpoch: hash,
  source,
  target: 'local',
  containerId: hash,
  resourceKey: '["docker","engine","container"]',
  expectedImage: { kind: 'docker-image-id', digest: `sha256:${hash}` },
  platform: 'linux/amd64',
  executionContextHash: hash,
};
const time = '2026-01-01T00:00:00.000Z';
const evidence = {
  version: 1,
  binding,
  bindingDigest: hash,
  probeVersion: 1,
  daemonCommit: null,
  implementationHash: null,
  startedAt: time,
  finishedAt: time,
  expiresAt: '2026-01-01T00:05:00.000Z',
  outcome: 'qualified',
  provenanceId: null,
  observations: [
    {
      prerequisite: 'launcher',
      launcher: 'jq',
      outcome: 'qualified',
      code: 'LAUNCHER_AVAILABLE',
      detail: 'Lookup succeeded; no operation was run',
    },
  ],
};

describe('repair continuation v1 contracts', () => {
  it('keeps missing historical execution mode checks-only', () => {
    expect(repairContinuationExecutionModeSchema.parse(undefined)).toBe('checks_only');
    expect(repairContinuationExecutionModeSchema.parse('qualify_then_code_once')).toBe(
      'qualify_then_code_once',
    );
    expect(repairContinuationExecutionModeSchema.safeParse('code').success).toBe(false);
  });
  it('accepts a bounded exact conditional request, never a caller proof/actor/command/grant', () => {
    expect(repairContinuationRequestV1Schema.parse(request)).toEqual(request);
    for (const extra of [
      'actor',
      'qualification',
      'receipt',
      'epoch',
      'command',
      'retryGrant',
      'remoteHead',
      'prepareOnly',
    ])
      expect(
        repairContinuationRequestV1Schema.safeParse({ ...request, [extra]: true }).success,
      ).toBe(false);
    for (const patch of [
      { version: 2 },
      { intent: 'checks_only' },
      { expectedGeneration: -1 },
      { expectedReportSetHash: '' },
      { sourceHead: 'main' },
      { reason: 'yes' },
      { id: '../repair' },
    ])
      expect(repairContinuationRequestV1Schema.safeParse({ ...request, ...patch }).success).toBe(
        false,
      );
  });
  it('does not coerce or default typed blocker claims and rejects command/operation selectors', () => {
    const blocker = {
      version: 1,
      kind: 'missing-execution-prerequisites',
      requirementsHash: hash,
      launchers: ['jq'],
    };
    expect(prerequisiteBlockerV1Schema.parse(blocker)).toEqual(blocker);
    for (const patch of [
      { version: '1' },
      { launchers: [] },
      { launchers: ['jq', 'jq'] },
      { launchers: ['sh;id'] },
      { launchers: ['./script'] },
      { launchers: ['-v'] },
      { launchers: Array.from({ length: 65 }, (_, i) => `tool${i}`) },
      { resolved: true },
      { minimumMemoryBytes: 1 },
      { lifecycleGeneration: 1 },
      { receipt: {} },
    ])
      expect(prerequisiteBlockerV1Schema.safeParse({ ...blocker, ...patch }).success).toBe(false);
  });
  it('keeps previews configuration-only and GET inspection can honestly be unavailable', () => {
    expect(
      repairContinuationPreviewQueryV1Schema.parse({
        sourceHead: head,
        executionProfileId: 'replacement',
      }),
    ).toBeDefined();
    const preview = {
      version: 1,
      intent: 'qualify_then_code_once',
      podId: 'pod',
      configurationOnly: true,
      actualQualification: 'not_run',
      conditionalAttemptEligible: false,
      selection: null,
      configurationDiff: null,
      refusals: [{ code: 'unsupported_needs', message: 'Legacy needs remain unqualified' }],
    };
    expect(repairContinuationPreviewV1Schema.parse(preview)).toEqual(preview);
    expect(
      repairContinuationPreviewV1Schema.safeParse({ ...preview, conditionalAttemptEligible: true })
        .success,
    ).toBe(false);
    expect(
      repairContinuationPreviewV1Schema.safeParse({ ...preview, configurationOnly: false }).success,
    ).toBe(false);
    const selection = {
      expectedGeneration: 2,
      expectedResultHash: hash,
      expectedReportSetHash: hash,
      sourceHead: head,
      executionProfileId: 'replacement',
      expectedExecutionDigest: hash,
      expectedBindingDigest: hash,
      requirementsHash: hash,
      target: 'local',
    };
    const before = {
      target: 'sandbox',
      template: 'node22',
      imageKey: hash,
      platform: 'linux/amd64',
      memoryGb: 4,
      cpus: 1,
    };
    const configurationDiff = { before, after: { ...before, target: 'local', memoryGb: 8 } };
    const conditional = {
      ...preview,
      conditionalAttemptEligible: true,
      selection,
      configurationDiff,
      refusals: [],
    };
    expect(
      repairContinuationPreviewV1Schema.safeParse({ ...conditional, configurationDiff: null })
        .success,
    ).toBe(false);
    expect(repairContinuationContextPaths('pod').sourceAndReports).toBe(
      '/pods/pod/checkpoint-recovery',
    );
    expect(repairContinuationContextPaths('pod').workerRetries).toBe(
      '/pods/pod/retry-state?stage=worker',
    );
    expect(repairContinuationPreviewV1Schema.parse(conditional).actualQualification).toBe(
      'not_run',
    );
    expect(environmentQualificationEvidenceV1Schema.safeParse(conditional).success).toBe(false);
    expect(
      repairContinuationPreviewV1Schema.safeParse({
        ...conditional,
        actualQualification: 'qualified',
      }).success,
    ).toBe(false);
    expect(
      repairContinuationRequestV1Schema.safeParse({ ...request, skipProbes: true }).success,
    ).toBe(false);
    expect(
      repairContinuationInspectionV1Schema.parse({
        version: 1,
        intent: 'qualify_then_code_once',
        podId: 'pod',
        generation: 2,
        available: false,
        expectedResultHash: null,
        expectedReportSetHash: null,
        sourceHead: null,
        requirementsHash: null,
        operation: null,
        refusals: preview.refusals,
      }),
    ).toBeDefined();
  });
  it('binds positive or uncertain evidence to exact identities and a five-minute maximum lifetime', () => {
    expect(environmentQualificationBindingV1Schema.parse(binding)).toEqual(binding);
    expect(environmentQualificationEvidenceV1Schema.parse(evidence)).toEqual(evidence);
    for (const patch of [
      { expiresAt: '2026-01-01T00:05:01.000Z' },
      { finishedAt: '2025-01-01T00:00:00.000Z' },
      { observations: [] },
      { observations: [{ ...evidence.observations[0], outcome: 'unknown' }] },
    ])
      expect(
        environmentQualificationEvidenceV1Schema.safeParse({ ...evidence, ...patch }).success,
      ).toBe(false);
    expect(
      environmentQualificationEvidenceV1Schema.parse({
        ...evidence,
        outcome: 'unknown',
        observations: [{ ...evidence.observations[0], outcome: 'unknown' }],
      }).outcome,
    ).toBe('unknown');
    expect(
      environmentQualificationBindingV1Schema.safeParse({ ...binding, target: 'sandbox' }).success,
    ).toBe(false);
    expect(
      environmentQualificationBindingV1Schema.safeParse({
        ...binding,
        expectedImage: { kind: 'registry-manifest', digest: `sha256:${hash}` },
      }).success,
    ).toBe(false);
  });
  it('projects a sealed final source separately and never authorizes publication', () => {
    const final = {
      version: 1,
      operationId: 'repair-1',
      generation: 3,
      taskRunId: 'run',
      selectedHead: head,
      source,
      clean: true,
      descendant: true,
      workerSettled: true,
      sealedAt: time,
      reportsHash: hash,
    };
    expect(repairCodingFinalSourceV1Schema.parse(final)).toEqual(final);
    expect(
      repairCodingFinalSourceV1Schema.safeParse({ ...final, workerSettled: false }).success,
    ).toBe(false);
    const operation = {
      version: 1,
      intent: 'qualify_then_code_once',
      podId: 'pod',
      request,
      state: 'validated',
      createdAt: time,
      updatedAt: time,
      originalGeneration: 2,
      candidateGeneration: 3,
      qualification: evidence,
      codingFinalSource: final,
      codingAdmission: 'consumed',
      checks: 'passed',
      refusals: [],
      originalResourcesRetained: true,
      requiresHumanApproval: true,
      publicationAuthorized: false,
    };
    expect(repairContinuationOperationV1Schema.parse(operation)).toEqual(operation);
    expect(
      repairContinuationOperationV1Schema.safeParse({ ...operation, publicationAuthorized: true })
        .success,
    ).toBe(false);
    expect(
      repairContinuationOperationV1Schema.safeParse({ ...operation, requiresHumanApproval: false })
        .success,
    ).toBe(false);
  });
});
