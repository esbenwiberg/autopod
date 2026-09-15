import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedPodRequest, ValidationEvidence } from '@autopod/shared';
import type { ArtifactExports } from './artifact-exports.js';
import { canonical } from './canonical.js';
import type { ManagedControls } from './managed-controls.js';
import type { ManagedPodService } from './managed-service.js';

/** Attempt completion packages intentional output only after observed writer exit. */
export class ManagedArtifactPipeline {
  private readonly running = new Map<string, Promise<void>>();
  constructor(
    readonly service: ManagedPodService,
    readonly exports: ArtifactExports,
    readonly stagingRoot: string,
    readonly controls: ManagedControls,
  ) {
    service.artifactPipeline = this;
  }
  async finish(installation: string, podId: string): Promise<void> {
    this.service.row(installation, podId);
    const prior = this.running.get(podId);
    if (prior) return prior;
    const run = this.execute(installation, podId).finally(() => this.running.delete(podId));
    this.running.set(podId, run);
    return run;
  }
  private async execute(installation: string, podId: string): Promise<void> {
    const row = this.service.row(installation, podId);
    if (!row.observed_exit || !row.runtime_ref)
      throw new Error('artifact-writer-not-observed-exited');
    if (!['validating', 'validated', 'review_required'].includes(row.state)) return;
    const spec = JSON.parse(row.request_json) as ManagedPodRequest;
    const storedLimitations = this.service.db
      .prepare('SELECT limitations_json FROM managed_results WHERE pod_id=?')
      .get(podId) as { limitations_json: string } | undefined;
    const limitations = storedLimitations
      ? (JSON.parse(storedLimitations.limitations_json) as string[])
      : [];
    const legacySourceFreezeFailure =
      limitations.includes('validation-incomplete') &&
      !this.service.db
        .prepare('SELECT 1 FROM managed_source_candidates WHERE pod_id=?')
        .get(podId) &&
      !this.service.db.prepare('SELECT 1 FROM managed_validations WHERE pod_id=?').get(podId);
    if (
      row.state === 'review_required' &&
      (limitations.includes('source-candidate-incomplete') || legacySourceFreezeFailure)
    ) {
      this.service.db
        .prepare("UPDATE managed_pods SET state='validating' WHERE pod_id=?")
        .run(podId);
    }
    const staging = path.join(this.stagingRoot, podId);
    const frozen = this.service.db
      .prepare('SELECT artifact_id FROM artifact_exports WHERE pod_id=?')
      .get(podId);
    let stage = 'artifact-export';
    try {
      if (!frozen && spec.outputs.artifacts.mode !== 'none') {
        if (!this.service.runtime.extractOutput) throw new Error('managed-output-unavailable');
        await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
        await rm(staging, { recursive: true, force: true });
        await this.service.runtime.extractOutput(row.runtime_ref, staging, spec.outputs.artifacts);
      }
      const receipt = await this.exports.export(
        {
          podId,
          dispatcherAttemptId: row.dispatcher_attempt_id,
          executionSpecDigest: row.execution_spec_digest,
        },
        staging,
        spec.outputs.artifacts,
        true,
      );
      // Preserve intentional worker artifacts even when validation subsequently fails.
      // Committed artifacts alone never establish acceptance or source-delivery authority.
      if (spec.validation.autopod) {
        stage = 'source-candidate';
        if (!this.service.source || !this.service.validation)
          throw new Error('managed-validation-unavailable');
        const candidate = await this.service.source.freeze(installation, podId);
        if (limitations.includes('source-candidate-incomplete') || legacySourceFreezeFailure) {
          this.service.db
            .prepare('UPDATE managed_results SET limitations_json=? WHERE pod_id=?')
            .run(
              canonical(
                limitations.filter(
                  (item) =>
                    item !== 'source-candidate-incomplete' &&
                    !(legacySourceFreezeFailure && item === 'validation-incomplete'),
                ),
              ),
              podId,
            );
        }
        stage = 'validation';
        await this.service.validation.finish(installation, podId, candidate);
        this.service.validation.assertActive(installation, podId);
      }
      const evidence: ValidationEvidence[] = receipt
        ? [
            {
              schemaVersion: 1,
              evidenceId: `artifact-${receipt.artifactId}`,
              dispatcherAttemptId: row.dispatcher_attempt_id,
              kind: 'validation',
              name: 'artifact-integrity',
              status: 'passed',
              digest: receipt.manifestSha256,
            },
          ]
        : [];
      this.service.db
        .transaction(() => {
          const prior = this.service.db
            .prepare('SELECT evidence_json FROM managed_results WHERE pod_id=?')
            .get(podId) as { evidence_json: string } | undefined;
          const combined = new Map<string, ValidationEvidence>();
          for (const item of [
            ...(prior ? (JSON.parse(prior.evidence_json) as ValidationEvidence[]) : []),
            ...evidence,
          ])
            combined.set(item.evidenceId, item);
          this.service.db
            .prepare(`INSERT INTO managed_results (pod_id,evidence_json) VALUES (?,?)
          ON CONFLICT(pod_id) DO UPDATE SET evidence_json=excluded.evidence_json`)
            .run(podId, canonical([...combined.values()]));
          const state = spec.outputs.source.mode === 'none' ? 'complete' : 'validated';
          this.service.db
            .prepare('UPDATE managed_pods SET state=? WHERE pod_id=?')
            .run(state, podId);
          this.controls.event(row, 'artifacts-finished', state);
        })
        .immediate();
      if (spec.outputs.source.mode !== 'none') {
        stage = 'source-candidate';
        if (!this.service.source) throw new Error('source-freeze-unavailable');
        await this.service.source.freeze(installation, podId);
      }
      await rm(staging, { recursive: true, force: true }).catch(() => {
        const stored = this.service.db
          .prepare('SELECT limitations_json FROM managed_results WHERE pod_id=?')
          .get(podId) as { limitations_json: string };
        this.service.db
          .prepare('UPDATE managed_results SET limitations_json=? WHERE pod_id=?')
          .run(
            canonical([
              ...new Set([...JSON.parse(stored.limitations_json), 'staging-cleanup-pending']),
            ]),
            podId,
          );
      });
    } catch (error) {
      const limitation =
        error instanceof Error && error.message === 'managed-agent-exit-failed'
          ? 'agent-runtime-failed'
          : `${stage}-incomplete`;
      const stored = this.service.db
        .prepare('SELECT limitations_json FROM managed_results WHERE pod_id=?')
        .get(podId) as { limitations_json: string } | undefined;
      const limitations = stored ? (JSON.parse(stored.limitations_json) as string[]) : [];
      this.service.db
        .prepare(`INSERT INTO managed_results (pod_id,limitations_json) VALUES (?,?)
        ON CONFLICT(pod_id) DO UPDATE SET limitations_json=excluded.limitations_json`)
        .run(podId, canonical([...new Set([...limitations, limitation])]));
      this.service.db
        .prepare("UPDATE managed_pods SET state='review_required' WHERE pod_id=?")
        .run(podId);
      throw new Error(
        limitation === 'agent-runtime-failed'
          ? 'managed-agent-runtime-failed'
          : `managed-${stage}-incomplete`,
      );
    }
  }
  async tick(): Promise<void> {
    const rows = this.service.db
      .prepare(
        `SELECT pod_id,dispatcher_installation_id FROM managed_pods WHERE observed_exit=1 AND cleanup='not-requested' AND
          (state IN ('validating','validated') OR (state='review_required' AND
            (EXISTS (SELECT 1 FROM artifact_exports WHERE artifact_exports.pod_id=managed_pods.pod_id AND error_code='artifact-export-retryable') OR
             EXISTS (SELECT 1 FROM managed_validations WHERE managed_validations.pod_id=managed_pods.pod_id AND
               json_extract(receipt_json,'$.mode')='deterministic' AND
               (json_extract(receipt_json,'$.status')='running' OR cleanup<>'observed')) OR
             EXISTS (SELECT 1 FROM managed_results,json_each(managed_results.limitations_json)
               WHERE managed_results.pod_id=managed_pods.pod_id AND json_each.value='source-candidate-incomplete') OR
             (NOT EXISTS (SELECT 1 FROM managed_source_candidates WHERE managed_source_candidates.pod_id=managed_pods.pod_id) AND
              NOT EXISTS (SELECT 1 FROM managed_validations WHERE managed_validations.pod_id=managed_pods.pod_id) AND
              EXISTS (SELECT 1 FROM managed_results,json_each(managed_results.limitations_json)
                WHERE managed_results.pod_id=managed_pods.pod_id AND json_each.value='validation-incomplete')))))`,
      )
      .all() as { pod_id: string; dispatcher_installation_id: string }[];
    for (const row of rows)
      await this.finish(row.dispatcher_installation_id, row.pod_id).catch(() => {});
  }
}
