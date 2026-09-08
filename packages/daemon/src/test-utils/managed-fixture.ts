import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import { ArtifactExports } from '../managed/artifact-exports.js';
import { ManagedArtifactPipeline } from '../managed/artifact-pipeline.js';
import { MemoryArtifactStore } from '../managed/artifact-store.js';
import { digest } from '../managed/canonical.js';
import { type ManagedAdmission, REQUIRED_ENFORCEMENT } from '../managed/grants.js';
import { ManagedControls } from '../managed/managed-controls.js';
import { ManagedPodService, type ManagedRuntimePort } from '../managed/managed-service.js';

export function resign(request: ManagedPodRequest): ManagedPodRequest {
  request.effectiveGrant.digest = digest(
    Object.fromEntries(Object.entries(request.effectiveGrant).filter(([key]) => key !== 'digest')),
  );
  request.executionSpecDigest = digest(
    Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'executionSpecDigest')),
  );
  return request;
}
export interface ManagedFixture {
  readonly db: Database.Database;
  request: ManagedPodRequest;
  runtime: ManagedRuntimePort;
  admission: ManagedAdmission;
  service(): ManagedPodService;
  restart(): void;
  close(): void;
  launches(): number;
  advance(value: number): void;
}
export function fixture(): ManagedFixture {
  const request: ManagedPodRequest = JSON.parse(
    readFileSync(
      new URL('../../../../specs/managed-pod/v1/examples.json', import.meta.url),
      'utf8',
    ),
  ).ManagedPodRequest;
  const directory = mkdtempSync(path.join(tmpdir(), 'managed-start-'));
  const database = path.join(directory, 'state.db');
  let db = new Database(database);
  for (const migration of [
    '142_managed_artifact_exports.sql',
    '143_managed_pods.sql',
    '144_managed_provider_allowances.sql',
    '145_managed_events_controls.sql',
    '146_managed_results.sql',
    '147_managed_inputs.sql',
    '148_managed_source.sql',
    '149_managed_sandbox_allocations.sql',
    '150_managed_workspaces.sql',
    '151_managed_provider_requests.sql',
    '152_managed_request_usage.sql',
  ]) {
    db.exec(readFileSync(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  let now = 100;
  let launches = 0;
  const processes = new Map<string, { started: boolean; expiry: number; stopped: boolean }>();
  const runtime: ManagedRuntimePort = {
    async preflight() {},
    async ensure(id, spec, checkpoint, fault) {
      let process = processes.get(id);
      if (!process) {
        process = { started: false, expiry: spec.effectiveGrant.budget.expiresAt, stopped: false };
        processes.set(id, process);
      }
      checkpoint(id);
      if (fault === 'after-runtime-identity') throw new Error('injected');
      if (!process.started) {
        process.started = true;
        launches++;
      }
      if (fault === 'after-agent-start') throw new Error('injected');
      return { runtimeRef: id };
    },
    async observe(id) {
      const process = processes.get(id)!;
      if (now >= process.expiry) process.stopped = true;
      return { state: process.stopped ? 'stopped' : 'running', consumedTokens: 0 };
    },
    async stop(id) {
      processes.get(id)!.stopped = true;
    },
  };
  const admission = {
    profiles: new Map([[request.profileSnapshot.snapshotDigest, request.profileSnapshot]]),
    enrollmentCeiling: request.profileSnapshot.scope,
    identityCeiling: request.profileSnapshot.scope,
    backendCeiling: request.profileSnapshot.scope,
    enforcement: REQUIRED_ENFORCEMENT,
    targets: ['local'] as const,
  };
  const service = () => {
    const value = new ManagedPodService(db, admission, runtime, () => now, true);
    new ManagedArtifactPipeline(
      value,
      new ArtifactExports(db, new MemoryArtifactStore()),
      path.join(directory, 'staging'),
      new ManagedControls(value),
    );
    return value;
  };
  return {
    get db() {
      return db;
    },
    restart: () => {
      db.close();
      db = new Database(database);
    },
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
    request,
    runtime,
    admission,
    service,
    launches: () => launches,
    advance: (value: number) => {
      now = value;
    },
  };
}

/** Explicit reviewed request/time fixture; old hard-token examples stay unchanged. */
export function requestTimeFixture(): ManagedFixture {
  const f = fixture();
  const budget = {
    mode: 'request-time' as const,
    maxProviderRequests: 1,
    maxDurationSeconds: 180,
    expiresAt: 400,
  };
  f.request.profileSnapshot.budget = { ...budget };
  f.request.effectiveGrant.budget = { ...budget };
  f.request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(f.request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
    ),
  );
  f.request.effectiveGrant.profileSnapshotDigest = f.request.profileSnapshot.snapshotDigest;
  resign(f.request);
  f.admission.profiles = new Map([
    [f.request.profileSnapshot.snapshotDigest, f.request.profileSnapshot],
  ]);
  return f;
}
