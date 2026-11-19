import { ArtifactManifestSchema, processContent } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { receiptFor, verifyBundle } from '../managed/artifact-store.js';
import { canonical } from '../managed/canonical.js';
import type { ResultWake } from './run-waves.js';

// Local frozen exports only. Never resolve a path, URL or artifact ID from worker text.
const maxArchiveBytes = 1024 * 1024;
export async function controllerFindings(
  db: Database.Database,
  run: string,
  wake: ResultWake,
  cases?: ReadonlyMap<string, { executionSpecDigest: string }>,
) {
  const lookup = db.prepare(`SELECT p.dispatcher_attempt_id,p.execution_spec_digest,
    CASE WHEN length(CAST(a.manifest_json AS BLOB))<=65536 THEN a.manifest_json END AS manifest,
    CASE WHEN length(CAST(a.receipt_json AS BLOB))<=4096 THEN a.receipt_json END AS receipt,
    CASE WHEN length(a.bundle_bytes)<=? THEN a.bundle_bytes END AS bundle
    FROM orchestration_continuations c JOIN managed_pods p ON p.pod_id=c.pod_id
    AND p.dispatcher_installation_id='native.'||c.run_id AND p.managed_start_key=c.start_key
    JOIN artifact_exports a ON a.pod_id=p.pod_id AND a.dispatcher_attempt_id=p.dispatcher_attempt_id
    AND a.execution_spec_digest=p.execution_spec_digest AND a.status='committed'
    WHERE c.run_id=? AND c.start_key=? AND p.pod_id=? AND a.artifact_id=?`);
  const findings = [];
  const limit = Math.min(2048, Math.floor(16384 / wake.results.length));
  for (const child of wake.results) {
    if (!child.artifact_id) {
      findings.push({ status: 'no-report' });
      continue;
    }
    const row = lookup.get(
      maxArchiveBytes,
      run,
      child.start_key,
      child.pod_id,
      child.artifact_id,
    ) as
      | {
          dispatcher_attempt_id: string;
          execution_spec_digest: string;
          manifest: string | null;
          receipt: string | null;
          bundle: Buffer | null;
        }
      | undefined;
    if (!row?.receipt) throw new Error('controller-artifact-binding');
    if (cases && cases.get(child.start_key)?.executionSpecDigest !== row.execution_spec_digest)
      throw new Error('controller-case-binding');
    if (!row.manifest || !row.bundle) {
      findings.push({ status: 'too-large' });
      continue;
    }
    const manifest = ArtifactManifestSchema.parse(JSON.parse(row.manifest));
    if (
      manifest.artifactId !== child.artifact_id ||
      manifest.podId !== child.pod_id ||
      manifest.dispatcherAttemptId !== row.dispatcher_attempt_id ||
      manifest.executionSpecDigest !== row.execution_spec_digest ||
      canonical(receiptFor(manifest)) !== row.receipt
    )
      throw new Error('controller-artifact-binding');
    if (manifest.totalBytes > maxArchiveBytes || manifest.fileCount > 128) {
      findings.push({ status: 'too-large' });
      continue;
    }
    const report = (await verifyBundle(manifest, row.bundle)).get('report.md');
    if (!report) {
      findings.push({ status: 'no-report' });
      continue;
    }
    let source: string;
    try {
      // stream mode omits a partial final UTF-8 code point at the excerpt boundary.
      source = new TextDecoder('utf-8', { fatal: true }).decode(report.subarray(0, limit), {
        stream: report.length > limit,
      });
      if (source.includes('\0')) throw new Error('not-text');
    } catch {
      findings.push({ status: 'not-text' });
      continue;
    }
    const filtered = processContent(source, { sanitization: { preset: 'strict' }, quarantine: {} });
    if (filtered.quarantined) {
      findings.push({ status: 'withheld' });
      continue;
    }
    const bytes = Buffer.from(filtered.text);
    const truncated = bytes.length > limit;
    findings.push({
      status: 'excerpt',
      text: new TextDecoder().decode(bytes.subarray(0, limit), { stream: truncated }),
      truncated: truncated || report.length > limit,
    });
  }
  return findings;
}
