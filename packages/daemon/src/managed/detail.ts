import type { ManagedPodRequest } from '@autopod/shared';
import type { ManagedControls } from './managed-controls.js';
import type { ManagedPodService } from './managed-service.js';
import { validationReceipt } from './validation.js';

export function managedDetail(
  service: ManagedPodService,
  controls: ManagedControls,
  installation: string,
  podId: string,
) {
  const row = service.row(installation, podId);
  const request = JSON.parse(row.request_json) as ManagedPodRequest;
  const observation = controls.observe(installation, podId, '0');
  const failure =
    service.db
      .prepare(`SELECT failure_phase AS phase,failure_reason AS reason,failure_http_status AS httpStatus
    FROM managed_provider_requests WHERE pod_id=? AND failure_phase IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
      .get(podId) ?? null;
  const artifacts = service.db
    .prepare(`SELECT artifact_id AS artifactId,status,file_count AS fileCount,total_bytes AS totalBytes,
    committed_at AS committedAt FROM artifact_exports WHERE pod_id=? ORDER BY created_at`)
    .all(podId);
  const recent = service.db
    .prepare(
      'SELECT event_json FROM managed_events WHERE pod_id=? ORDER BY sequence DESC LIMIT 100',
    )
    .all(podId) as { event_json: string }[];
  const events = recent.reverse().map((e) => JSON.parse(e.event_json));
  const validations = validationReceipt(service, podId);
  const operation = service.db
    .prepare('SELECT request_json FROM managed_source_operations WHERE pod_id=?')
    .get(podId) as { request_json: string } | undefined;
  const verification = operation ? JSON.parse(operation.request_json).verificationReceipt : null;
  return {
    schemaVersion: 1,
    pod: {
      podId,
      dispatcherAttemptId: row.dispatcher_attempt_id,
      state: row.state,
      ...request.route,
      profileId: request.profileSnapshot.profileId,
      profileVersion: request.profileSnapshot.profileVersion,
      providerRequests: observation.result.providerRequests ?? 0,
      consumedTokens: row.consumed_tokens,
      tokenUsageKnown: observation.result.tokenUsageKnown ?? false,
      failure,
      artifacts,
      limitations: observation.result.limitations,
      revoked: Boolean(row.revoked),
      stopRequested: Boolean(row.stop_requested),
      observedExit: Boolean(row.observed_exit),
      cleanup: row.cleanup,
      exitCode: row.exit_code,
      createdAt: row.created_at,
      lastEventAt: events.at(-1)?.createdAt ?? row.created_at,
      validationStatus:
        validations?.status ??
        (request.validation.autopod?.mode === 'off'
          ? 'disabled'
          : request.validation.autopod
            ? 'not-run'
            : 'not-requested'),
    },
    validationChoice: request.validation.autopod ?? null,
    validations: validations ? [validations] : [],
    candidates: observation.result.candidates,
    source: observation.result.source,
    verification,
    evidence: observation.result.evidence,
    events,
  };
}
