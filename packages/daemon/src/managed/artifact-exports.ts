import { randomUUID } from 'node:crypto';
import {
  type ArtifactManifest,
  type ArtifactOutput,
  type ArtifactReceipt,
  ArtifactReceiptSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { collectOutput } from './artifact-collector.js';
import { type ArtifactStore, receiptFor } from './artifact-store.js';
import { canonical, digest, sha256 } from './canonical.js';

interface ExportRow {
  artifact_id: string;
  pod_id: string;
  dispatcher_attempt_id: string;
  execution_spec_digest: string;
  status: string;
  manifest_json: string;
  bundle_bytes: Buffer;
  receipt_json: string | null;
}
export interface ExportBinding {
  podId: string;
  dispatcherAttemptId: string;
  executionSpecDigest: string;
}

/** Freezes bytes/provenance once in SQLite. Delivery retries never call a runtime. */
export class ArtifactExports {
  constructor(
    private readonly db: Database.Database,
    private readonly store: ArtifactStore,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async export(
    binding: ExportBinding,
    root: string,
    output: ArtifactOutput,
    observedWriterExit: boolean,
    fault?: 'after-freeze' | 'after-commit',
  ): Promise<ArtifactReceipt | null> {
    const prior = this.db
      .prepare('SELECT * FROM artifact_exports WHERE pod_id=?')
      .get(binding.podId) as ExportRow | undefined;
    if (prior) {
      if (
        prior.dispatcher_attempt_id !== binding.dispatcherAttemptId ||
        prior.execution_spec_digest !== binding.executionSpecDigest
      ) {
        throw new Error('artifact-binding-conflict');
      }
      return this.deliver(prior.artifact_id, fault);
    }
    if (!observedWriterExit) throw new Error('artifact-writer-still-active');
    const collected = await collectOutput(root, output);
    if (!collected) return null;
    const artifactId = `art-${randomUUID()}`;
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      artifactId,
      ...binding,
      createdAt: this.now(),
      files: collected.files,
      fileCount: collected.files.length,
      totalBytes: collected.totalBytes,
      bundle: { format: 'tar.gz', size: collected.bundle.length, sha256: sha256(collected.bundle) },
    };
    const prefix = `managed-pods/${binding.podId}/${artifactId}`;
    const freeze = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM artifact_exports WHERE pod_id=?')
        .get(binding.podId) as ExportRow | undefined;
      if (existing) {
        if (
          existing.execution_spec_digest !== binding.executionSpecDigest ||
          existing.dispatcher_attempt_id !== binding.dispatcherAttemptId
        ) {
          throw new Error('artifact-binding-conflict');
        }
        return existing.artifact_id;
      }
      this.db
        .prepare(`INSERT INTO artifact_exports (artifact_id,pod_id,dispatcher_attempt_id,execution_spec_digest,
        status,manifest_json,manifest_sha256,bundle_sha256,bundle_bytes,blob_manifest_name,blob_bundle_name,
        file_count,total_bytes,created_at) VALUES (?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)`)
        .run(
          artifactId,
          binding.podId,
          binding.dispatcherAttemptId,
          binding.executionSpecDigest,
          canonical(manifest),
          digest(manifest),
          manifest.bundle.sha256,
          collected.bundle,
          `${prefix}/manifest.json`,
          `${prefix}/bundle.tar.gz`,
          manifest.fileCount,
          manifest.totalBytes,
          manifest.createdAt,
        );
      return artifactId;
    });
    const frozenId = freeze();
    if (fault === 'after-freeze') throw new Error('injected-after-freeze');
    return this.deliver(frozenId, fault);
  }

  async deliver(id: string, fault?: string): Promise<ArtifactReceipt> {
    const row = this.db.prepare('SELECT * FROM artifact_exports WHERE artifact_id=?').get(id) as
      | ExportRow
      | undefined;
    if (!row) throw new Error('artifact-not-found');
    if (row.receipt_json) return ArtifactReceiptSchema.parse(JSON.parse(row.receipt_json));
    this.db
      .prepare("UPDATE artifact_exports SET status='uploading',error_code=NULL WHERE artifact_id=?")
      .run(id);
    try {
      const receipt = await this.store.commit({
        manifest: JSON.parse(row.manifest_json) as ArtifactManifest,
        bundle: row.bundle_bytes,
      });
      if (
        canonical(receipt) !==
        canonical(receiptFor(JSON.parse(row.manifest_json) as ArtifactManifest))
      ) {
        throw new Error('artifact-receipt-binding-mismatch');
      }
      if (fault === 'after-commit') throw new Error('injected-after-commit');
      this.db
        .prepare(
          "UPDATE artifact_exports SET status='committed',receipt_json=?,committed_at=?,error_code=NULL WHERE artifact_id=?",
        )
        .run(canonical(receipt), this.now(), id);
      return receipt;
    } catch (error) {
      const permanent =
        error instanceof Error && /integrity|immutable|receipt-binding/.test(error.message);
      const code = permanent ? 'artifact-integrity-failure' : 'artifact-export-retryable';
      this.db
        .prepare(
          "UPDATE artifact_exports SET status='failed',error_code=? WHERE artifact_id=? AND receipt_json IS NULL",
        )
        .run(code, id);
      throw new Error(code);
    }
  }
  getReceipt(id: string): ArtifactReceipt {
    const row = this.db
      .prepare('SELECT receipt_json FROM artifact_exports WHERE artifact_id=?')
      .get(id) as { receipt_json: string | null } | undefined;
    if (!row?.receipt_json) throw new Error('artifact-not-committed');
    return ArtifactReceiptSchema.parse(JSON.parse(row.receipt_json));
  }
}
