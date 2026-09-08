import { expect, it } from 'vitest';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { composeManagedAcceptance, parseManagedAcceptanceConfig } from './acceptance-config.js';
import { digest } from './canonical.js';

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

it('accepts one exact report-only sandbox request and rejects broader activation', () => {
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
    const broadArtifactRequest = structuredClone(value.request);
    broadArtifactRequest.outputs.artifacts.limits.maxTotalBytes = 32 * 1024;
    resign(broadArtifactRequest);
    for (const changed of [
      { ...value, enabled: true },
      { ...value, token: 'secret' },
      { ...value, image: 'registry.example/autopod/self:latest' },
      { ...value, mirror: { ...value.mirror, path: 'relative' } },
      { ...value, request: inputRequest },
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

it('composes one service and rejects a changed request before runtime allocation', async () => {
  const { f, value } = input();
  try {
    const config = parseManagedAcceptanceConfig(JSON.stringify(value));
    if (!config) throw new Error('expected-config');
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
