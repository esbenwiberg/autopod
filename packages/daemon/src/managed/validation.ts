import {
  type ManagedPodRequest,
  type ManagedValidationReceipt,
  type SourceCandidateReceipt,
  type ValidationPhase,
  type ValidationResult,
  parseManagedRecord,
} from '@autopod/shared';
import type {
  ValidationEngineConfig,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import { canonical, digest } from './canonical.js';
import type { ManagedPodService } from './managed-service.js';

/** Commands are trusted deployment inputs selected by a digest in the immutable request. */
export interface ManagedValidationPort {
  /** Return the exact selected phases from the configuration whose digest is bound to the request.
   * The production implementation must supervise repository commands beyond daemon lifetime.
   */
  preflight(request: ManagedPodRequest): readonly Exclude<ValidationPhase, 'review' | 'advisory'>[];
  run(
    request: ManagedPodRequest,
    candidate: SourceCandidateReceipt,
    callbacks: ValidationPhaseCallbacks,
    signal: AbortSignal,
    checkpoint: (containerId: string) => void,
  ): Promise<ValidationResult>;
  cleanup(containerId: string): Promise<void>;
}

export type ManagedValidationConfig = Pick<
  ValidationEngineConfig,
  | 'buildCommand'
  | 'testCommand'
  | 'lintCommand'
  | 'sastCommand'
  | 'validationSetupCommand'
  | 'startCommand'
  | 'healthPath'
  | 'healthTimeout'
  | 'smokePages'
  | 'buildWorkDir'
  | 'buildTimeout'
  | 'testTimeout'
  | 'lintTimeout'
  | 'sastTimeout'
  | 'hasWebUi'
  | 'contract'
> & {
  phases: Exclude<ValidationPhase, 'review' | 'advisory'>[];
};

export function validationReceipt(
  service: ManagedPodService,
  podId: string,
): ManagedValidationReceipt | null {
  const row = service.db
    .prepare('SELECT receipt_json FROM managed_validations WHERE pod_id=?')
    .get(podId) as { receipt_json: string } | undefined;
  if (!row) return null;
  const receipt = parseManagedRecord(
    'ManagedValidationReceiptSchema',
    JSON.parse(row.receipt_json),
  );
  const { receiptDigest, ...body } = receipt;
  if (digest(body) !== receiptDigest || receipt.podId !== podId)
    throw new Error('managed-validation-integrity');
  return receipt;
}

export function requireValidation(
  service: ManagedPodService,
  request: ManagedPodRequest,
  candidate: SourceCandidateReceipt,
): void {
  const choice = request.validation.autopod;
  if (!choice) return; // Historical requests never claimed AutoPod validation.
  const receipt = validationReceipt(service, candidate.podId);
  if (
    !receipt ||
    receipt.mode !== choice.mode ||
    receipt.configurationDigest !== choice.configurationDigest ||
    receipt.executionSpecDigest !== request.executionSpecDigest ||
    receipt.dispatcherAttemptId !== request.dispatcherAttemptId ||
    receipt.newCommit !== candidate.newCommit ||
    receipt.candidateDigest !== candidate.candidateDigest ||
    receipt.status !== (choice.mode === 'off' ? 'disabled' : 'passed')
  ) {
    throw new Error('managed-validation-required');
  }
}

export class ManagedValidationRunner {
  private readonly running = new Map<string, Promise<void>>();
  constructor(
    readonly service: ManagedPodService,
    readonly port?: ManagedValidationPort,
  ) {}

  assertActive(installation: string, podId: string): void {
    const row = this.service.row(installation, podId);
    if (!row.observed_exit || row.revoked || row.stop_requested || this.service.expired(row))
      throw new Error('managed-validation-grant-inactive');
  }

  preflight(request: ManagedPodRequest): void {
    const choice = request.validation.autopod;
    if (!choice) return;
    if (request.task.kind !== 'implementation' || request.outputs.source.mode === 'none')
      throw new Error('managed-validation-source-required');
    if (choice.mode === 'off') return;
    if (!request.effectiveGrant.scope.allowedEffects.includes('test.run'))
      throw new Error('managed-validation-not-granted');
    if (!this.port) throw new Error('managed-validation-unavailable');
    const phases = this.port.preflight(request);
    if (
      !phases.length ||
      phases.length !== new Set(phases).size ||
      phases.some(
        (p) => !['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'facts'].includes(p),
      )
    )
      throw new Error('managed-validation-phases-invalid');
  }

  finish(installation: string, podId: string, candidate: SourceCandidateReceipt): Promise<void> {
    this.service.row(installation, podId);
    const existing = this.running.get(podId);
    if (existing) return existing;
    const promise = this.execute(installation, podId, candidate).finally(() =>
      this.running.delete(podId),
    );
    this.running.set(podId, promise);
    return promise;
  }

  private async execute(installation: string, podId: string, candidate: SourceCandidateReceipt) {
    const row = this.service.row(installation, podId);
    const request = JSON.parse(row.request_json) as ManagedPodRequest;
    const choice = request.validation.autopod;
    if (!choice) return;
    if (
      candidate.podId !== podId ||
      candidate.dispatcherAttemptId !== request.dispatcherAttemptId ||
      candidate.executionSpecDigest !== request.executionSpecDigest
    )
      throw new Error('managed-validation-candidate-binding');
    const previous = validationReceipt(this.service, podId);
    if (previous && previous.status !== 'running') {
      requireValidation(this.service, request, candidate);
      return;
    }
    // A durable running record with no local owner represents uncertain execution after restart.
    // Never replay repository commands automatically.
    if (previous) {
      throw new Error('managed-validation-execution-unreconciled');
    }
    this.assertActive(installation, podId);
    const receipt: ManagedValidationReceipt = {
      schemaVersion: 1,
      validationId: `validation-${podId}`,
      podId,
      dispatcherAttemptId: request.dispatcherAttemptId,
      executionSpecDigest: request.executionSpecDigest,
      configurationDigest: choice.configurationDigest,
      mode: choice.mode,
      status: choice.mode === 'off' ? 'disabled' : 'running',
      candidateDigest: candidate.candidateDigest,
      newCommit: candidate.newCommit,
      startedAt: this.service.now(),
      completedAt: 0,
      phases: [],
      reason: choice.mode === 'off' ? 'disabled-by-configuration' : '',
      receiptDigest: digest({}),
    };
    // Claim once across simultaneous service instances.
    const claim = this.service.db
      .prepare(
        'INSERT OR IGNORE INTO managed_validations(pod_id,validation_id,receipt_json) VALUES (?,?,?)',
      )
      .run(podId, receipt.validationId, this.serialize(receipt));
    if (!claim.changes) throw new Error('managed-validation-owned');
    if (choice.mode === 'off') {
      receipt.completedAt = this.service.now();
      this.save(receipt);
      return;
    }
    const controller = new AbortController();
    const assertCurrent = () => {
      try {
        this.assertActive(installation, podId);
      } catch {
        controller.abort();
        throw new Error('managed-validation-grant-inactive');
      }
      if (controller.signal.aborted) throw new Error('managed-validation-interrupted');
    };
    const timer = setInterval(() => {
      try {
        assertCurrent();
      } catch {
        /* Abort consumed by runner. */
      }
    }, 250);
    timer.unref();
    const update = (
      phase: ValidationPhase,
      status: ManagedValidationReceipt['phases'][number]['status'],
      result?: unknown,
    ) => {
      assertCurrent();
      if (phase === 'review' || phase === 'advisory') return;
      const duration =
        result &&
        typeof result === 'object' &&
        'duration' in result &&
        typeof result.duration === 'number'
          ? result.duration
          : 0;
      const entry = { phase, status, durationMs: Math.max(0, Math.floor(duration)) };
      receipt.phases = [...receipt.phases.filter((p) => p.phase !== phase), entry];
      this.save(receipt);
      this.service.onTransition?.(row, `validation-${phase}-${status}`, 'validating');
    };
    try {
      this.preflight(request);
      const port = this.port;
      if (!port) throw new Error('managed-validation-unavailable');
      const requiredPhases = port.preflight(request);
      const result = await port.run(
        request,
        candidate,
        {
          onPhaseStarted: (phase) => update(phase, 'running'),
          onPhaseCompleted: (phase, status, result) =>
            update(
              phase,
              (
                {
                  pass: 'passed',
                  fail: 'failed',
                  skip: 'skipped',
                  pending_human: 'pending-human',
                } as const
              )[status],
              result,
            ),
        },
        controller.signal,
        (containerId) => {
          this.service.db
            .prepare('UPDATE managed_validations SET container_id=? WHERE pod_id=?')
            .run(containerId, podId);
          assertCurrent();
        },
      );
      assertCurrent();
      receipt.status = result.infrastructureFailure
        ? 'unavailable'
        : result.overall === 'pass' &&
            requiredPhases.every((phase) =>
              receipt.phases.some((p) => p.phase === phase && p.status === 'passed'),
            )
          ? 'passed'
          : 'failed';
      receipt.reason = result.infrastructureFailure
        ? 'validation-infrastructure-unavailable'
        : result.overall === 'pass' && receipt.status !== 'passed'
          ? 'validation-required-phases-incomplete'
          : '';
    } catch {
      receipt.status = 'unavailable';
      receipt.reason = controller.signal.aborted
        ? 'validation-interrupted'
        : 'validation-run-unavailable';
    } finally {
      clearInterval(timer);
      const allocation = this.service.db
        .prepare('SELECT container_id FROM managed_validations WHERE pod_id=?')
        .get(podId) as { container_id: string | null };
      if (allocation.container_id && this.port) {
        try {
          await this.port.cleanup(allocation.container_id);
          this.service.db
            .prepare("UPDATE managed_validations SET cleanup='observed' WHERE pod_id=?")
            .run(podId);
        } catch {
          receipt.status = 'unavailable';
          receipt.reason = 'validation-cleanup-unobserved';
        }
      }
      receipt.completedAt = this.service.now();
      this.save(receipt);
    }
    requireValidation(this.service, request, candidate);
  }

  private serialize(receipt: ManagedValidationReceipt): string {
    const { receiptDigest: _digest, ...body } = receipt;
    return canonical(
      parseManagedRecord('ManagedValidationReceiptSchema', {
        ...body,
        receiptDigest: digest(body),
      }),
    );
  }
  private save(receipt: ManagedValidationReceipt): void {
    this.service.db.transaction(() => this.saveWithinTransaction(receipt)).immediate();
  }

  private saveWithinTransaction(receipt: ManagedValidationReceipt): void {
    const serialized = this.serialize(receipt);
    this.service.db
      .prepare('UPDATE managed_validations SET receipt_json=? WHERE pod_id=?')
      .run(serialized, receipt.podId);
    const stored = this.service.db
      .prepare('SELECT evidence_json FROM managed_results WHERE pod_id=?')
      .get(receipt.podId) as { evidence_json: string } | undefined;
    const evidence = stored
      ? (JSON.parse(stored.evidence_json) as Array<{ evidenceId: string }>)
      : [];
    const value = JSON.parse(serialized) as ManagedValidationReceipt;
    const entry = {
      schemaVersion: 1,
      evidenceId: receipt.validationId,
      dispatcherAttemptId: receipt.dispatcherAttemptId,
      kind: 'validation',
      name: 'autopod-validation',
      status:
        receipt.status === 'passed' ? 'passed' : receipt.status === 'failed' ? 'failed' : 'not-run',
      digest: value.receiptDigest,
    };
    this.service.db
      .prepare(
        'INSERT INTO managed_results(pod_id,evidence_json) VALUES (?,?) ON CONFLICT(pod_id) DO UPDATE SET evidence_json=excluded.evidence_json',
      )
      .run(
        receipt.podId,
        canonical([...evidence.filter((e) => e.evidenceId !== receipt.validationId), entry]),
      );
  }
}
