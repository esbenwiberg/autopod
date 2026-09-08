import { expect, it } from 'vitest';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { composeManagedAcceptance, parseManagedAcceptanceConfig } from './acceptance-config.js';
import { canonical, digest } from './canonical.js';

const cli = {
  bindings: [
    {
      issuer: 'https://issuer/',
      audience: 'api://autopod',
      objectId: 'owner',
      installationId: 'installation-one',
    },
  ],
  blobContainerUrl: 'https://fixture.blob.core.windows.net/private',
};

function input() {
  const f = requestTimeFixture();
  const request = f.request;
  request.route.executionTarget = 'sandbox';
  request.profileSnapshot.route = structuredClone(request.route);
  request.effectiveGrant.route = structuredClone(request.route);
  request.outputs.artifacts.requiredPaths = ['report.md'];
  request.outputs.artifacts.include = ['report.md'];
  request.outputs.artifacts.limits = {
    maxFiles: 1,
    maxFileBytes: 16 * 1024,
    maxTotalBytes: 16 * 1024,
  };
  request.profileSnapshot.budget.expiresAt = 4_102_444_800;
  request.effectiveGrant.budget.expiresAt = 4_102_444_800;
  request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
    ),
  );
  request.effectiveGrant.profileSnapshotDigest = request.profileSnapshot.snapshotDigest;
  resign(request);
  const repository = request.effectiveGrant.scope.repositories[0];
  if (!repository) throw new Error('expected-repository');
  return {
    f,
    value: {
      mode: 'single-job-canary-v1',
      installationId: 'installation-one',
      request,
      mirror: {
        enrollmentId: repository.enrollmentId,
        path: '/data/mirrors/fixture.git',
        remote: repository.remote,
        baseRevision: repository.baseRevision,
      },
      image:
        'registry.example/autopod/self@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
}

it('accepts one exact bounded input and rejects broader activation', () => {
  const { f, value } = input();
  try {
    const parsed = parseManagedAcceptanceConfig(JSON.stringify(value));
    expect(parsed?.request.executionSpecDigest).toBe(value.request.executionSpecDigest);
    expect(parseManagedAcceptanceConfig(undefined)).toBeUndefined();
    const inputRequest = structuredClone(value.request);
    inputRequest.inputArtifacts = [
      {
        name: 'input',
        backendArtifactId: 'artifact',
        manifestSha256: `sha256:${'b'.repeat(64)}`,
        mountPath: '/inputs/input',
        access: 'read',
      },
    ];
    resign(inputRequest);
    const secondInputRequest = structuredClone(inputRequest);
    secondInputRequest.inputArtifacts.push({
      name: 'other',
      backendArtifactId: 'other-artifact',
      manifestSha256: `sha256:${'c'.repeat(64)}`,
      mountPath: '/inputs/other',
      access: 'read',
    });
    resign(secondInputRequest);
    expect(
      parseManagedAcceptanceConfig(JSON.stringify({ ...value, request: inputRequest }))?.request
        .inputArtifacts,
    ).toEqual(inputRequest.inputArtifacts);
    const broadArtifactRequest = structuredClone(value.request);
    broadArtifactRequest.outputs.artifacts.limits.maxTotalBytes = 32 * 1024;
    resign(broadArtifactRequest);
    for (const changed of [
      { ...value, enabled: true },
      { ...value, token: 'secret' },
      { ...value, image: 'registry.example/autopod/self:latest' },
      { ...value, mirror: { ...value.mirror, path: 'relative' } },
      { ...value, request: secondInputRequest },
      { ...value, request: broadArtifactRequest },
    ]) {
      expect(() => parseManagedAcceptanceConfig(JSON.stringify(changed))).toThrow(
        'managed-acceptance-config-invalid',
      );
    }
  } finally {
    f.close();
  }
});

it('requires the reviewed input to be a small committed artifact owned by the installation', () => {
  const { f, value } = input();
  try {
    const request = structuredClone(value.request);
    request.inputArtifacts = [
      {
        name: 'research',
        backendArtifactId: 'artifact-one',
        manifestSha256: `sha256:${'b'.repeat(64)}`,
        mountPath: '/inputs/research',
        access: 'read',
      },
    ];
    resign(request);
    const reviewedInput = request.inputArtifacts[0];
    if (!reviewedInput) throw new Error('expected-input');
    const config = parseManagedAcceptanceConfig(JSON.stringify({ ...value, request }));
    if (!config) throw new Error('expected-config');
    const manager = {
      ensureManagedContainer: async () => 'sandbox',
      extractManagedOutput: async () => {},
    } as never;
    const dependencies = {
      db: f.db,
      databasePath: '/data/autopod/autopod.db',
      manager,
      providerAccounts: {
        get: () => ({
          id: request.route.providerAccountId,
          name: 'fixture',
          provider: 'openai',
          credentials: {
            provider: 'openai',
            authMode: 'chatgpt',
            authJson: JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: { access_token: 'fixture-token', account_id: 'chatgpt-account' },
            }),
          },
          failoverPolicy: null,
          createdAt: '',
          updatedAt: '',
          lastAuthenticatedAt: null,
          lastUsedAt: null,
        }),
      } as never,
    };
    expect(() => composeManagedAcceptance(config, cli, dependencies)).toThrow(
      'managed-acceptance-input-invalid',
    );

    const upstream = f.request;
    f.db
      .prepare(
        `INSERT INTO managed_pods (
          pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,
          execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,
          effective_grant_digest,request_json,handle_json,state,revoked,stop_requested,
          observed_exit,cleanup,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'complete',0,0,1,'observed',?)`,
      )
      .run(
        'managed-upstream',
        config.installationId,
        upstream.dispatcherAttemptId,
        upstream.startKey,
        upstream.executionSpecDigest,
        upstream.profileSnapshot.snapshotDigest,
        upstream.effectiveGrant.grantId,
        upstream.effectiveGrant.revision,
        upstream.effectiveGrant.digest,
        canonical(upstream),
        '{}',
        100,
      );
    f.db
      .prepare(
        `INSERT INTO artifact_exports (
          artifact_id,pod_id,dispatcher_attempt_id,execution_spec_digest,status,
          manifest_json,manifest_sha256,bundle_sha256,bundle_bytes,blob_manifest_name,
          blob_bundle_name,file_count,total_bytes,error_code,error_detail,created_at,
          committed_at,receipt_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'artifact-one',
        'managed-upstream',
        upstream.dispatcherAttemptId,
        upstream.executionSpecDigest,
        'committed',
        '{}',
        reviewedInput.manifestSha256,
        `sha256:${'a'.repeat(64)}`,
        Buffer.from('bundle'),
        'managed-pods/managed-upstream/artifact-one/manifest.json',
        'managed-pods/managed-upstream/artifact-one/bundle.tar.gz',
        1,
        1,
        null,
        null,
        100,
        100,
        '{}',
      );
    const runtime = composeManagedAcceptance(config, cli, dependencies);
    expect(runtime.components.service.health().enabled).toBe(true);
    runtime.close();

    f.db.prepare('UPDATE managed_pods SET dispatcher_installation_id=?').run('other-installation');
    expect(() => composeManagedAcceptance(config, cli, dependencies)).toThrow(
      'managed-acceptance-input-invalid',
    );
    f.db.prepare('UPDATE managed_pods SET dispatcher_installation_id=?').run(config.installationId);
    f.db.prepare('UPDATE artifact_exports SET manifest_sha256=?').run(`sha256:${'0'.repeat(64)}`);
    expect(() => composeManagedAcceptance(config, cli, dependencies)).toThrow(
      'managed-acceptance-input-invalid',
    );
    f.db
      .prepare('UPDATE artifact_exports SET manifest_sha256=?,file_count=2')
      .run(reviewedInput.manifestSha256);
    expect(() => composeManagedAcceptance(config, cli, dependencies)).toThrow(
      'managed-acceptance-input-invalid',
    );
    f.db.prepare('UPDATE artifact_exports SET file_count=1,total_bytes=?').run(16 * 1024 + 1);
    expect(() => composeManagedAcceptance(config, cli, dependencies)).toThrow(
      'managed-acceptance-input-invalid',
    );
  } finally {
    f.close();
  }
});

it('composes one service and rejects a changed request before runtime allocation', async () => {
  const { f, value } = input();
  try {
    const config = parseManagedAcceptanceConfig(JSON.stringify(value));
    if (!config) throw new Error('expected-config');
    const historical = structuredClone(config.request);
    historical.dispatcherJobId = 'historical-job';
    historical.dispatcherAttemptId = 'historical-attempt';
    historical.startKey = 'historical-start';
    historical.effectiveGrant.grantId = 'historical-grant';
    historical.effectiveGrant.dispatcherAttemptId = historical.dispatcherAttemptId;
    resign(historical);
    f.db
      .prepare(
        `INSERT INTO managed_pods (
          pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,
          execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,
          effective_grant_digest,request_json,handle_json,state,revoked,stop_requested,
          observed_exit,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'killed',1,1,1,?)`,
      )
      .run(
        'managed-historical',
        config.installationId,
        historical.dispatcherAttemptId,
        historical.startKey,
        historical.executionSpecDigest,
        historical.profileSnapshot.snapshotDigest,
        historical.effectiveGrant.grantId,
        historical.effectiveGrant.revision,
        historical.effectiveGrant.digest,
        canonical(historical),
        '{}',
        100,
      );
    const manager = {
      ensureManagedContainer: async () => 'sandbox',
      extractManagedOutput: async () => {},
    } as never;
    const runtime = composeManagedAcceptance(config, cli, {
      db: f.db,
      databasePath: '/data/autopod/autopod.db',
      manager,
      providerAccounts: {
        get: () => ({
          id: config.request.route.providerAccountId,
          name: 'fixture',
          provider: 'openai',
          credentials: {
            provider: 'openai',
            authMode: 'chatgpt',
            authJson: JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: { access_token: 'fixture-token', account_id: 'chatgpt-account' },
            }),
          },
          failoverPolicy: null,
          createdAt: '',
          updatedAt: '',
          lastAuthenticatedAt: null,
          lastUsedAt: null,
        }),
      } as never,
    });
    expect(runtime.components.service.health().enabled).toBe(true);
    await expect(
      runtime.components.service.preflight(config.request, config.installationId),
    ).resolves.toEqual(config.request);
    await expect(runtime.resume()).resolves.toBeUndefined();
    const changed = structuredClone(config.request);
    changed.dispatcherJobId = 'other';
    resign(changed);
    await expect(
      runtime.components.service.preflight(changed, config.installationId),
    ).rejects.toThrow('managed-request-not-reviewed');
    runtime.close();
    f.db.prepare("UPDATE managed_pods SET observed_exit=0,state='queued'").run();
    expect(() =>
      composeManagedAcceptance(config, cli, {
        db: f.db,
        databasePath: '/data/autopod/autopod.db',
        manager,
        providerAccounts: {} as never,
      }),
    ).toThrow('managed-acceptance-existing-attempt-conflict');
  } finally {
    f.close();
  }
});

it('requires exactly one matching authenticated installation', () => {
  const { f, value } = input();
  try {
    const config = parseManagedAcceptanceConfig(JSON.stringify(value));
    if (!config) throw new Error('expected-config');
    expect(() =>
      composeManagedAcceptance(
        config,
        { ...cli, bindings: [] },
        {
          db: f.db,
          databasePath: '/data/autopod/autopod.db',
          manager: f.runtime as never,
          providerAccounts: {} as never,
        },
      ),
    ).toThrow('managed-acceptance-dependency-invalid');
  } finally {
    f.close();
  }
});
