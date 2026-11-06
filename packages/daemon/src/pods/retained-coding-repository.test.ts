import type {
  EnvironmentQualificationBindingV1,
  EnvironmentQualificationEvidenceV1,
} from '@autopod/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { admitCodexRecovery } from '../runtimes/codex-recovery-admission.js';
import {
  createPassingValidationResult,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import {
  assertCheckpointResourceNotRetained,
  checkpointHash,
  ownsInfrastructureRecoveryStop,
} from './retained-checkpoint-repository.js';
import { assertSourceDeliveryAllowed } from './source-custody-guards.js';
import { unavailableWorkerInputs, workerBindingHash } from './worker-retry-history.js';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = createTestDb();
  databases.push(db);
  insertTestProfile(db);
  const pods = createPodRepository(db);
  pods.insert({
    id: 'pod',
    status: 'failed',
    executionTarget: 'local',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    profileName: 'test-profile',
    task: 'Preserve work',
    branch: 'autopod/pod',
    model: 'claude-sonnet-4-6',
    runtime: 'claude',
    userId: 'operator',
  });
  const result = createPassingValidationResult('pod', 1);
  pods.update('pod', {
    status: 'failed',
    containerId: '1'.repeat(64),
    worktreePath: '/original',
    lastValidationResult: result,
  });
  const pod = pods.getOrThrow('pod');
  const roots = pods.retainedCheckpoints!;
  const coding = pods.retainedCoding!;
  const task = pods.taskExecutions!.snapshot('pod');
  const request = {
    id: 'repair-one',
    expectedGeneration: pod.lifecycleGeneration,
    expectedResultHash: checkpointHash(result),
    checkpointHead: 'a'.repeat(40),
    reason: 'One bounded retained coding operation',
  };
  roots.claim({
    pod,
    taskId: task.taskId,
    resourceKey: 'docker://original',
    request,
    actor: { type: 'human', userId: 'operator' },
    assertCurrent: () => {},
    binding: {
      repository: 'https://github.com/org/repo',
      branch: pod.branch,
      head: request.checkpointHead,
      cycle: 0,
      resultHash: request.expectedResultHash,
      configurationHash: 'a'.repeat(64),
      continuation: { prepareOnly: false },
    },
    onClaim: () =>
      coding.claim(request.id, pod, request, 'b'.repeat(64), {
        version: 1,
        mode: 'qualify_then_code_once',
        reportSetHash: 'a'.repeat(64),
        requirementsHash: 'a'.repeat(64),
        parentDigest: 'a'.repeat(64),
        executionDigest: 'a'.repeat(64),
        bindingDigest: 'a'.repeat(64),
      }),
  });
  roots.append(request.id, 'prepared', {
    worktree: '/candidate',
    bare: '/repository.git',
    snapshot: '/snapshot',
    bundle: '/source.bundle',
    bundleHash: 'a'.repeat(64),
    head: request.checkpointHead,
    tree: 'b'.repeat(40),
    hostInventoryHash: 'a'.repeat(64),
  });
  roots.owned(request.id, () =>
    pods.atomically!(() => {
      const generation = pods.incrementLifecycleGeneration('pod');
      pods.update('pod', {
        containerId: null,
        worktreePath: '/candidate',
        lastValidationResult: null,
        skipAgent: false,
      });
      roots.append(request.id, 'activated', { generation });
    }),
  );
  const owned = <T>(fn: () => T) => roots.owned(request.id, () => coding.owned(request.id, fn));
  owned(() => {
    coding.enter(request.id, 'reserved-candidate-name');
    coding.append(request.id, 'candidate', {
      containerId: '2'.repeat(64),
      generation: pods.getOrThrow('pod').lifecycleGeneration,
      expectedImage: `sha256:${'a'.repeat(64)}`,
    });
    pods.update('pod', { containerId: '2'.repeat(64) });
  });
  const binding: EnvironmentQualificationBindingV1 = {
    version: 1,
    operationId: request.id,
    requestHash: 'b'.repeat(64),
    podId: 'pod',
    taskId: task.taskId,
    executionId: task.executionId,
    custodyId: request.id,
    originalGeneration: pod.lifecycleGeneration,
    candidateGeneration: pods.getOrThrow('pod').lifecycleGeneration,
    originalResultHash: request.expectedResultHash,
    reportSetHash: 'a'.repeat(64),
    requirementsHash: 'a'.repeat(64),
    originalLaunchDigest: 'a'.repeat(64),
    replacementLaunchDigest: 'a'.repeat(64),
    configurationHash: 'a'.repeat(64),
    sourceEpoch: 'a'.repeat(64),
    credentialEpoch: 'a'.repeat(64),
    resourceEpoch: 'a'.repeat(64),
    source: {
      repository: 'https://github.com/org/repo',
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      baseCommitSha: 'a'.repeat(40),
    },
    target: 'local',
    containerId: '2'.repeat(64),
    resourceKey: 'docker://candidate',
    expectedImage: { kind: 'docker-image-id', digest: `sha256:${'a'.repeat(64)}` },
    platform: 'linux/amd64',
    executionContextHash: 'a'.repeat(64),
  };
  const evidence: EnvironmentQualificationEvidenceV1 = {
    version: 1,
    binding,
    bindingDigest: configurationDigest(binding),
    probeVersion: 1,
    daemonCommit: null,
    implementationHash: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    outcome: 'qualified',
    observations: [
      {
        prerequisite: 'launcher',
        outcome: 'qualified',
        code: 'LOOKUP',
        detail: 'Declared launcher found',
        launcher: 'jq',
      },
    ],
    provenanceId: null,
  };
  const qualify = (proof = evidence) =>
    owned(() =>
      coding.append(request.id, 'qualified', {
        processEpoch: coding.processEpoch,
        expiresAt: proof.expiresAt,
        evidence: proof,
      }),
    );
  return { db, pods, roots, coding, request, owned, evidence, qualify };
}
describe('retained coding private one-use accounting capability', () => {
  it('authorization/reservation alone cannot admit a worker or release delivery', () => {
    const f = fixture();
    expect(() => f.owned(() => f.coding.assertWorkerAllowed('pod'))).toThrow('qualification');
    expect(() => assertSourceDeliveryAllowed(f.db, 'pod')).toThrow();
    expect(() => f.roots.assertWorkerAllowed('pod')).toThrow();
    expect(f.pods.taskExecutions!.snapshot('pod').agentRunCount).toBe(0);
  });
  it('requires fresh positive evidence and atomically consumes exactly one run/retry/cycle', () => {
    const f = fixture();
    f.qualify();
    expect(() => f.coding.assertWorkerAllowed('pod')).toThrow();
    f.owned(() =>
      f.pods.atomically!(() => {
        f.pods.completionJournal!.begin(f.pods.getOrThrow('pod'));
        const cycle = f.pods.completionJournal!.get(
          'pod',
          f.pods.getOrThrow('pod').lifecycleGeneration,
        )!.cycle;
        const run = f.pods.taskExecutions!.beginRun(
          'pod',
          f.pods.getOrThrow('pod').lifecycleGeneration,
          cycle,
          {
            runtime: 'claude',
            model: 'claude-sonnet-4-6',
            providerAccountId: null,
            resource: { containerId: '2'.repeat(64), executionTarget: 'local' },
          },
        );
        f.pods.workerRetries!.admit(
          'pod',
          f.pods.getOrThrow('pod').lifecycleGeneration,
          unavailableWorkerInputs,
          workerBindingHash({
            runtime: 'claude',
            model: 'claude-sonnet-4-6',
            providerAccountId: null,
          }),
          [],
          run,
        );
        f.coding.bindWorker('pod', run, cycle, 1);
      }),
    );
    expect(f.pods.taskExecutions!.snapshot('pod').agentRunCount).toBe(1);
    expect(() => f.owned(() => f.coding.assertWorkerAllowed('pod'))).toThrow();
    expect(() => f.owned(() => f.coding.assertCompletedWorker('pod'))).toThrow('settlement');
    expect(() => f.owned(() => assertSourceDeliveryAllowed(f.db, 'pod'))).toThrow();
    expect(() =>
      f.db.prepare("DELETE FROM retained_coding_facts WHERE kind='worker'").run(),
    ).toThrow('cannot be deleted');
  });
  it('keeps checkpoint, qualified coding and original-stop capabilities separate', async () => {
    const f = fixture();
    f.qualify();
    expect(() => f.roots.owned(f.request.id, () => f.roots.assertWorkerAllowed('pod'))).toThrow();
    expect(() => f.coding.owned(f.request.id, () => f.roots.assertWorkerAllowed('pod'))).toThrow();
    expect(f.owned(() => f.roots.assertWorkerAllowed('pod'))).toBe(true);
    expect(f.owned(() => ownsInfrastructureRecoveryStop(f.db, '1'.repeat(64)))).toBe(false);
    expect(() => f.owned(() => f.roots.infrastructureEvent(f.request.id, 'stopped', {}))).toThrow(
      'Owned infrastructure recovery required',
    );
    const stop = () => {
      throw new Error('Original must never be stopped by coding custody');
    };
    await expect(f.owned(() => f.roots.stopOriginal(f.request.id, stop, () => {}))).rejects.toThrow(
      'Only owned prepared original quiescence',
    );
    expect(f.db.prepare('SELECT * FROM retained_infrastructure_events').all()).toEqual([]);
    expect(() =>
      f.owned(() => assertCheckpointResourceNotRetained(f.db, '1'.repeat(64), true)),
    ).toThrow();
  });
  it('does not turn failed or expired observations into coding permission', () => {
    for (const kind of ['failed', 'expired'] as const) {
      const f = fixture();
      f.qualify({
        ...f.evidence,
        ...(kind === 'failed'
          ? { outcome: 'failed' as const }
          : { expiresAt: new Date(Date.now() - 1).toISOString() }),
      });
      expect(() => f.owned(() => f.coding.assertWorkerAllowed('pod'))).toThrow();
    }
  });
  it('does not admit an automatic native Codex interruption segment', () => {
    const f = fixture();
    f.qualify();
    expect(() =>
      f.owned(() =>
        admitCodexRecovery(
          f.pods,
          'pod',
          f.pods.getOrThrow('pod'),
          '2'.repeat(64),
          'native-session',
          'resume',
        ),
      ),
    ).toThrow('one fresh coding segment');
    expect(f.pods.codexInterruptionRetries!.state('pod').admissionCount).toBe(0);
  });
  it('retains candidate and original independently of mutable pointers, including private cleanup callers', () => {
    const f = fixture();
    f.qualify();
    expect(() => assertCheckpointResourceNotRetained(f.db, '1'.repeat(64))).toThrow();
    expect(() => assertCheckpointResourceNotRetained(f.db, '2'.repeat(64))).toThrow('custody');
    expect(() => f.owned(() => assertCheckpointResourceNotRetained(f.db, '2'.repeat(64)))).toThrow(
      'custody',
    );
    expect(() =>
      f.owned(() => assertCheckpointResourceNotRetained(f.db, '2'.repeat(64), true)),
    ).not.toThrow();
    expect(() => assertCheckpointResourceNotRetained(f.db, '2'.repeat(64), true)).toThrow();
    expect(f.pods.listReferencedContainerIds()).toContain('2'.repeat(64));
  });
});
