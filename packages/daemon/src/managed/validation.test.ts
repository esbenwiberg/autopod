import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedPodRequest, SourceCandidateReceipt, ValidationResult } from '@autopod/shared';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { managedPodRoutes } from '../api/routes/managed-pods.js';
import { fixture, resign } from '../test-utils/managed-fixture.js';
import { ArtifactExports } from './artifact-exports.js';
import { ManagedArtifactPipeline } from './artifact-pipeline.js';
import { MemoryArtifactStore } from './artifact-store.js';
import { canonical, digest } from './canonical.js';
import { ManagedControls } from './managed-controls.js';
import type { ManagedSourceDelivery } from './source-delivery.js';
import {
  type ManagedValidationPort,
  ManagedValidationRunner,
  requireValidation,
  validationReceipt,
} from './validation.js';

async function setup(mode: 'off' | 'deterministic', outcome: 'pass' | 'fail' = 'pass') {
  const f = fixture();
  const service = f.service();
  const handle = await service.start('installation-one', f.request);
  const spec = structuredClone(f.request);
  spec.task.kind = 'implementation';
  spec.outputs.source.mode = 'branch';
  spec.effectiveGrant.scope.allowedEffects.push('test.run');
  spec.validation.autopod = { mode, configurationDigest: digest({ phases: ['build'] }) };
  resign(spec);
  f.db
    .prepare(
      'UPDATE managed_pods SET request_json=?,execution_spec_digest=?,observed_exit=1,state=? WHERE pod_id=?',
    )
    .run(canonical(spec), spec.executionSpecDigest, 'validating', handle.podId);
  const candidate: SourceCandidateReceipt = {
    schemaVersion: 1,
    candidateId: 'candidate-one',
    podId: handle.podId,
    dispatcherAttemptId: spec.dispatcherAttemptId,
    executionSpecDigest: spec.executionSpecDigest,
    repository: 'repo',
    remote: 'origin',
    head: 'worker/one',
    base: 'main',
    expectedOldCommit: '0'.repeat(40),
    newCommit: 'a'.repeat(40),
    evidenceDigest: digest({}),
    candidateDigest: digest({ candidate: true }),
  };
  const port: ManagedValidationPort = {
    preflight: vi.fn(() => ['build'] as const),
    cleanup: vi.fn(async () => {}),
    run: vi.fn(async (_request, _candidate, _deadline, callbacks, _signal, checkpoint) => {
      checkpoint('validation-ref');
      callbacks.onPhaseStarted?.('build');
      callbacks.onPhaseCompleted?.('build', outcome, { duration: 12 });
      return { overall: outcome } as ValidationResult;
    }),
  };
  const runner = new ManagedValidationRunner(service, port);
  service.validation = runner;
  return { f, service, spec, candidate, port, runner };
}

it('explicit off records disabled and survives restart without running commands', async () => {
  const { f, service, spec, candidate, port, runner } = await setup('off');
  try {
    await runner.finish('installation-one', candidate.podId, candidate);
    expect(port.run).not.toHaveBeenCalled();
    expect(validationReceipt(service, candidate.podId)).toMatchObject({
      status: 'disabled',
      mode: 'off',
      phases: [],
    });
    await new ManagedValidationRunner(service, port).finish(
      'installation-one',
      candidate.podId,
      candidate,
    );
    expect(() => requireValidation(service, spec, candidate)).not.toThrow();
    expect(port.run).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('persists phases once, preserves artifact evidence and rejects a changed candidate', async () => {
  const { f, service, spec, candidate, port, runner } = await setup('deterministic');
  try {
    f.db
      .prepare('INSERT INTO managed_results(pod_id,evidence_json) VALUES (?,?)')
      .run(candidate.podId, canonical([{ evidenceId: 'artifact-existing' }]));
    await Promise.all([
      runner.finish('installation-one', candidate.podId, candidate),
      runner.finish('installation-one', candidate.podId, candidate),
    ]);
    expect(port.run).toHaveBeenCalledOnce();
    expect(validationReceipt(service, candidate.podId)).toMatchObject({
      status: 'passed',
      phases: [{ phase: 'build', status: 'passed', durationMs: 12 }],
    });
    expect(() =>
      requireValidation(service, spec, { ...candidate, newCommit: 'b'.repeat(40) }),
    ).toThrow('managed-validation-required');
    const row = f.db
      .prepare('SELECT evidence_json FROM managed_results WHERE pod_id=?')
      .get(candidate.podId) as { evidence_json: string };
    expect(
      JSON.parse(row.evidence_json).map((e: { evidenceId: string }) => e.evidenceId),
    ).toContain('artifact-existing');
  } finally {
    f.close();
  }
});

it('failed validation cannot pass the delivery gate or replay commands', async () => {
  const { f, service, spec, candidate, port, runner } = await setup('deterministic', 'fail');
  try {
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow(
      'managed-validation-required',
    );
    expect(validationReceipt(service, candidate.podId)?.status).toBe('failed');
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow();
    expect(port.run).toHaveBeenCalledOnce();
    expect(() => requireValidation(service, spec, candidate)).toThrow();
  } finally {
    f.close();
  }
});

it('revocation during checks records unavailable and blocks delivery', async () => {
  const { f, service, candidate, port, runner } = await setup('deterministic');
  port.run = vi.fn(async () => {
    f.db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(candidate.podId);
    return { overall: 'pass' } as ValidationResult;
  });
  try {
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow();
    expect(validationReceipt(service, candidate.podId)?.status).toBe('unavailable');
  } finally {
    f.close();
  }
});

it('validation detail is passive and installation scoped', async () => {
  const { f, service, candidate, runner } = await setup('off');
  const app = Fastify();
  managedPodRoutes(app, {
    service,
    authenticate: async (req) => (req.headers['x-test'] === 'owner' ? 'installation-one' : 'other'),
  });
  try {
    await runner.finish('installation-one', candidate.podId, candidate);
    const url = `/managed/pods/${candidate.podId}`;
    const detail = await app.inject({ url, headers: { 'x-test': 'owner' } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().validations[0].status).toBe('disabled');
    expect((await app.inject({ url })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/managed/validations/validation-${candidate.podId}` })).statusCode,
    ).toBe(404);
    expect(f.launches()).toBe(1);
  } finally {
    await app.close();
    f.close();
  }
});

it('enabled validation requires a supported runner and test authority', () => {
  const f = fixture();
  try {
    const request = {
      ...f.request,
      task: { ...f.request.task, kind: 'implementation' },
      outputs: { ...f.request.outputs, source: { ...f.request.outputs.source, mode: 'branch' } },
      validation: {
        ...f.request.validation,
        autopod: { mode: 'deterministic', configurationDigest: digest({}) },
      },
    } as ManagedPodRequest;
    const runner = new ManagedValidationRunner(f.service());
    request.effectiveGrant.scope.allowedEffects = ['repository.read'];
    expect(() => runner.preflight(request)).toThrow('managed-validation-not-granted');
    request.effectiveGrant.scope.allowedEffects.push('test.run');
    expect(() => runner.preflight(request)).toThrow('managed-validation-unavailable');
  } finally {
    f.close();
  }
});

it('missing selected phase evidence is not a pass', async () => {
  const { f, service, candidate, port, runner } = await setup('deterministic');
  port.run = vi.fn(async () => ({ overall: 'pass' }) as ValidationResult);
  try {
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow(
      'managed-validation-required',
    );
    expect(validationReceipt(service, candidate.podId)).toMatchObject({
      status: 'failed',
      reason: 'validation-required-phases-incomplete',
    });
  } finally {
    f.close();
  }
});

it('retains committed artifacts and validation evidence when validation fails', async () => {
  const { f, service, candidate } = await setup('deterministic', 'fail');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-validation-artifacts-')));
  try {
    service.source = { freeze: vi.fn(async () => candidate) } as unknown as ManagedSourceDelivery;
    f.runtime.extractOutput = async (_ref, destination) => {
      await mkdir(destination);
      await writeFile(path.join(destination, 'research.md'), 'Fixture artifact');
    };
    const controls = new ManagedControls(service);
    const pipeline = new ManagedArtifactPipeline(
      service,
      new ArtifactExports(f.db, new MemoryArtifactStore()),
      root,
      controls,
    );
    await expect(pipeline.finish('installation-one', candidate.podId)).rejects.toThrow(
      'managed-validation-incomplete',
    );
    const result = controls.observe('installation-one', candidate.podId, '0').result;
    expect(result.state).toBe('review_required');
    expect(result.artifacts).toHaveLength(1);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ name: 'autopod-validation', status: 'failed' }),
    );
    expect(result.source).toEqual([]);
  } finally {
    f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('a durable running receipt reconciles through the idempotent port after restart', async () => {
  const { f, service, candidate, port, runner } = await setup('deterministic');
  try {
    await runner.finish('installation-one', candidate.podId, candidate);
    const receipt = validationReceipt(service, candidate.podId);
    if (!receipt) throw new Error('missing-test-receipt');
    receipt.status = 'running';
    receipt.completedAt = 0;
    receipt.receiptDigest = digest(
      Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'receiptDigest')),
    );
    f.db
      .prepare('UPDATE managed_validations SET receipt_json=? WHERE pod_id=?')
      .run(canonical(receipt), candidate.podId);
    await new ManagedValidationRunner(service, port).finish(
      'installation-one',
      candidate.podId,
      candidate,
    );
    expect(port.run).toHaveBeenCalledTimes(2);
    expect(port.cleanup).toHaveBeenCalledTimes(2);
  } finally {
    f.close();
  }
});

it('a terminal pass with pending cleanup is not deliverable and cleanup resumes after restart', async () => {
  const { f, service, spec, candidate, port, runner } = await setup('deterministic');
  try {
    await runner.finish('installation-one', candidate.podId, candidate);
    f.db
      .prepare("UPDATE managed_validations SET cleanup='not-requested' WHERE pod_id=?")
      .run(candidate.podId);
    expect(() => requireValidation(service, spec, candidate)).toThrow(
      'managed-validation-required',
    );
    await new ManagedValidationRunner(service, port).finish(
      'installation-one',
      candidate.podId,
      candidate,
    );
    expect(port.run).toHaveBeenCalledOnce();
    expect(port.cleanup).toHaveBeenCalledTimes(2);
    expect(() => requireValidation(service, spec, candidate)).not.toThrow();
  } finally {
    f.close();
  }
});

it('recovers a passed receipt after transient cleanup failure without rerunning validation', async () => {
  const { f, service, spec, candidate, port, runner } = await setup('deterministic');
  vi.mocked(port.cleanup).mockRejectedValueOnce(new Error('cleanup-transport-unavailable'));
  try {
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow(
      'managed-validation-required',
    );
    expect(validationReceipt(service, candidate.podId)).toMatchObject({
      status: 'passed',
      reason: 'validation-cleanup-unobserved',
    });
    await new ManagedValidationRunner(service, port).finish(
      'installation-one',
      candidate.podId,
      candidate,
    );
    expect(port.run).toHaveBeenCalledOnce();
    expect(port.cleanup).toHaveBeenCalledTimes(2);
    expect(validationReceipt(service, candidate.podId)).toMatchObject({
      status: 'passed',
      reason: '',
    });
    expect(() => requireValidation(service, spec, candidate)).not.toThrow();
  } finally {
    f.close();
  }
});

it('the artifact reconciler resumes pending validation cleanup without rerunning commands', async () => {
  const { f, service, candidate, port } = await setup('deterministic');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-validation-cleanup-')));
  vi.mocked(port.cleanup).mockRejectedValueOnce(new Error('cleanup-transport-unavailable'));
  try {
    service.source = { freeze: vi.fn(async () => candidate) } as unknown as ManagedSourceDelivery;
    f.runtime.extractOutput = async (_ref, destination) => {
      await mkdir(destination);
      await writeFile(path.join(destination, 'research.md'), 'Fixture artifact');
    };
    const controls = new ManagedControls(service);
    const pipeline = new ManagedArtifactPipeline(
      service,
      new ArtifactExports(f.db, new MemoryArtifactStore()),
      root,
      controls,
    );
    await expect(pipeline.finish('installation-one', candidate.podId)).rejects.toThrow(
      'managed-validation-incomplete',
    );
    expect(controls.observe('installation-one', candidate.podId, '0').result.state).toBe(
      'review_required',
    );
    await pipeline.tick();
    expect(port.run).toHaveBeenCalledOnce();
    expect(port.cleanup).toHaveBeenCalledTimes(2);
    expect(controls.observe('installation-one', candidate.podId, '0').result.state).toBe(
      'validated',
    );
  } finally {
    f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['current source-freeze limitation', false],
  ['legacy validation limitation without a receipt', true],
] as const)('the artifact reconciler retries %s and clears it', async (_case, legacy) => {
  const { f, service, candidate, port } = await setup('deterministic');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-source-recovery-')));
  const freeze = vi
    .fn<() => Promise<SourceCandidateReceipt>>()
    .mockRejectedValueOnce(new Error('source-sync-unavailable'))
    .mockResolvedValue(candidate);
  try {
    service.source = { freeze } as unknown as ManagedSourceDelivery;
    f.runtime.extractOutput = async (_ref, destination) => {
      await mkdir(destination);
      await writeFile(path.join(destination, 'research.md'), 'Fixture artifact');
    };
    const controls = new ManagedControls(service);
    const pipeline = new ManagedArtifactPipeline(
      service,
      new ArtifactExports(f.db, new MemoryArtifactStore()),
      root,
      controls,
    );

    await expect(pipeline.finish('installation-one', candidate.podId)).rejects.toThrow(
      'managed-source-candidate-incomplete',
    );
    expect(controls.observe('installation-one', candidate.podId, '0').result).toMatchObject({
      state: 'review_required',
      limitations: ['source-candidate-incomplete'],
    });
    if (legacy) {
      f.db
        .prepare('UPDATE managed_results SET limitations_json=? WHERE pod_id=?')
        .run(canonical(['validation-incomplete']), candidate.podId);
    }

    await pipeline.tick();

    // One failed capture, one recovery capture, then the existing idempotent delivery replay.
    expect(freeze).toHaveBeenCalledTimes(3);
    expect(port.run).toHaveBeenCalledOnce();
    expect(controls.observe('installation-one', candidate.podId, '0').result).toMatchObject({
      state: 'validated',
      limitations: [],
    });
  } finally {
    f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('an observation gap keeps the run open and reconciles without premature cleanup', async () => {
  const { f, service, spec, candidate, port, runner } = await setup('deterministic');
  const successful = port.run;
  port.run = vi.fn(async (_request, _candidate, _deadline, _callbacks, _signal, checkpoint) => {
    checkpoint('validation-ref');
    throw new Error('transport-unavailable');
  });
  try {
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow(
      'managed-validation-execution-unreconciled',
    );
    expect(validationReceipt(service, candidate.podId)).toMatchObject({
      status: 'running',
      reason: 'validation-execution-unreconciled',
      completedAt: 0,
    });
    expect(port.cleanup).not.toHaveBeenCalled();
    port.run = successful;
    await new ManagedValidationRunner(service, port).finish(
      'installation-one',
      candidate.podId,
      candidate,
    );
    expect(port.cleanup).toHaveBeenCalledOnce();
    expect(() => requireValidation(service, spec, candidate)).not.toThrow();
  } finally {
    f.close();
  }
});

it('records a source mutation before command start as a terminal validation failure', async () => {
  const { f, service, candidate, port, runner } = await setup('deterministic');
  port.run = vi.fn(async () => {
    throw new Error('managed-validation-source-mismatch');
  });
  try {
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow(
      'managed-validation-required',
    );
    expect(validationReceipt(service, candidate.podId)).toMatchObject({
      status: 'failed',
      reason: 'source-mutated',
      completedAt: expect.any(Number),
    });
    expect(port.cleanup).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it.each(['stop_requested', 'revoked'])('does not launch after %s', async (flag) => {
  const { f, candidate, port, runner } = await setup('deterministic');
  try {
    f.db.prepare(`UPDATE managed_pods SET ${flag}=1 WHERE pod_id=?`).run(candidate.podId);
    await expect(runner.finish('installation-one', candidate.podId, candidate)).rejects.toThrow(
      'managed-validation-grant-inactive',
    );
    expect(port.run).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('does not launch for a candidate from another attempt', async () => {
  const { f, candidate, port, runner } = await setup('deterministic');
  try {
    await expect(
      runner.finish('installation-one', candidate.podId, {
        ...candidate,
        dispatcherAttemptId: 'other',
      }),
    ).rejects.toThrow('managed-validation-candidate-binding');
    expect(port.run).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
