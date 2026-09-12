import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedPodRequest, ValidationEvidence } from '@autopod/shared';
import type { ArtifactExports } from './artifact-exports.js';
import { canonical } from './canonical.js';
import type { ManagedControls } from './managed-controls.js';
import type { ManagedPodService } from './managed-service.js';

/** Attempt completion packages intentional output only after observed writer exit. */
export class ManagedArtifactPipeline {
  constructor(
    readonly service: ManagedPodService,
    readonly exports: ArtifactExports,
    readonly stagingRoot: string,
    readonly controls: ManagedControls,
  ) {
    service.artifactPipeline = this;
  }
  async finish(installation: string, podId: string): Promise<void> {
    const row = this.service.row(installation, podId);
    if (!row.observed_exit || !row.runtime_ref)
      throw new Error('artifact-writer-not-observed-exited');
    if (!['validating', 'validated', 'review_required'].includes(row.state)) return;
    const spec = JSON.parse(row.request_json) as ManagedPodRequest;
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
          this.service.db
            .prepare(`INSERT INTO managed_results (pod_id,evidence_json) VALUES (?,?)
          ON CONFLICT(pod_id) DO UPDATE SET evidence_json=excluded.evidence_json,limitations_json='[]'`)
            .run(podId, canonical(evidence));
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
        this.service.db
          .prepare(
            'UPDATE managed_results SET limitations_json=\'["staging-cleanup-pending"]\' WHERE pod_id=?',
          )
          .run(podId);
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
        "SELECT pod_id,dispatcher_installation_id FROM managed_pods WHERE observed_exit=1 AND (state IN ('validating','validated') OR (state='review_required' AND EXISTS (SELECT 1 FROM artifact_exports WHERE artifact_exports.pod_id=managed_pods.pod_id AND error_code='artifact-export-retryable')))",
      )
      .all() as { pod_id: string; dispatcher_installation_id: string }[];
    for (const row of rows)
      await this.finish(row.dispatcher_installation_id, row.pod_id).catch(() => {});
  }
}
