import { expect, it } from 'vitest';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import {
  parseManagedProfileSetConfig,
  profileSetRequestPolicy,
  unionScope,
} from './profile-set-config.js';

function input() {
  const f = requestTimeFixture();
  const request = f.request;
  request.route.executionTarget = 'sandbox';
  request.profileSnapshot.route = structuredClone(request.route);
  request.effectiveGrant.route = structuredClone(request.route);
  request.outputs.artifacts.requiredPaths = ['research.md'];
  request.outputs.artifacts.include = ['research.md'];
  request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
    ),
  );
  request.effectiveGrant.profileSnapshotDigest = request.profileSnapshot.snapshotDigest;
  resign(request);
  const repository = request.profileSnapshot.scope.repositories[0];
  if (!repository) throw new Error('expected-repository');
  const value = {
    mode: 'reviewed-profile-set-v1',
    installationId: 'installation-one',
    profiles: [
      {
        profileSnapshot: request.profileSnapshot,
        taskKind: 'research',
        artifactPath: 'research.md',
        inputNames: [],
        sourceMode: 'none',
      },
    ],
    mirror: {
      enrollmentId: repository.enrollmentId,
      path: '/data/mirrors/fixture.git',
      remote: repository.remote,
      baseRevision: repository.baseRevision,
      dependencyCachePath: '/opt/autopod-managed/fixture/node_modules',
    },
    image:
      'registry.example/autopod/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  return { f, request, value };
}

it('accepts a secretless exact profile set and enforces stage inputs and outputs', () => {
  const { f, request, value } = input();
  try {
    const parsed = parseManagedProfileSetConfig(JSON.stringify(value));
    if (!parsed) throw new Error('expected-config');
    const policy = profileSetRequestPolicy(parsed);
    expect(() => policy(request)).not.toThrow();
    for (const changed of [
      { task: { ...request.task, kind: 'planning' as const } },
      {
        outputs: {
          ...request.outputs,
          source: { ...request.outputs.source, mode: 'branch' as const },
        },
      },
      {
        outputs: {
          ...request.outputs,
          artifacts: { ...request.outputs.artifacts, include: ['**/*'] },
        },
      },
      {
        inputArtifacts: [
          {
            name: 'unexpected',
            backendArtifactId: 'artifact',
            manifestSha256: `sha256:${'b'.repeat(64)}`,
            mountPath: '/inputs/unexpected',
            access: 'read' as const,
          },
        ],
      },
    ]) {
      expect(() => policy({ ...request, ...changed })).toThrow('managed-profile-stage-mismatch');
    }
  } finally {
    f.close();
  }
});

it('accepts an exact digest-pinned package registry allowlist', () => {
  const { f, request, value } = input();
  try {
    request.profileSnapshot.scope.network = {
      profileId: 'autopod-package-registry',
      destinations: ['registry.npmjs.org'],
    };
    request.effectiveGrant.scope.network = structuredClone(request.profileSnapshot.scope.network);
    request.profileSnapshot.snapshotDigest = digest(
      Object.fromEntries(
        Object.entries(request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
      ),
    );
    request.effectiveGrant.profileSnapshotDigest = request.profileSnapshot.snapshotDigest;
    resign(request);

    const parsed = parseManagedProfileSetConfig(JSON.stringify(value));
    if (!parsed) throw new Error('expected-config');
    expect(parsed.profiles[0]?.profileSnapshot.scope.network).toEqual({
      profileId: 'autopod-package-registry',
      destinations: ['registry.npmjs.org'],
    });
    expect(() => profileSetRequestPolicy(parsed)(request)).not.toThrow();
  } finally {
    f.close();
  }
});

it('includes every reviewed stage destination in the profile-set ceiling', () => {
  const { f, value } = input();
  try {
    const registryStage = structuredClone(value.profiles[0]);
    if (!registryStage) throw new Error('expected-profile');
    registryStage.profileSnapshot.profileId = 'implementation-with-packages';
    registryStage.profileSnapshot.scope.network = {
      profileId: 'autopod-package-registry',
      destinations: ['registry.npmjs.org'],
    };
    registryStage.profileSnapshot.snapshotDigest = digest(
      Object.fromEntries(
        Object.entries(registryStage.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
      ),
    );
    value.profiles.push(registryStage);

    const parsed = parseManagedProfileSetConfig(JSON.stringify(value));
    if (!parsed) throw new Error('expected-config');
    expect(unionScope(parsed.profiles).network.destinations).toEqual(['registry.npmjs.org']);
  } finally {
    f.close();
  }
});

it('rejects widened, ambiguous, or incomplete profile-set bindings', () => {
  const { f, value } = input();
  try {
    const profile = value.profiles[0];
    if (!profile) throw new Error('expected-profile');
    const withIdentity = structuredClone(value);
    const identityProfile = withIdentity.profiles[0];
    if (!identityProfile) throw new Error('expected-profile');
    identityProfile.profileSnapshot.scope.identityBindings = [
      { alias: 'github-read', bindingDigest: `sha256:${'b'.repeat(64)}` },
    ];
    identityProfile.profileSnapshot.scope.allowedEffects.push('github.issue.read');
    identityProfile.profileSnapshot.snapshotDigest = digest(
      Object.fromEntries(
        Object.entries(identityProfile.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
      ),
    );
    for (const changed of [
      { ...value, image: 'registry.example/autopod/worker:latest' },
      { ...value, mirror: { ...value.mirror, path: 'relative' } },
      { ...value, mirror: { ...value.mirror, baseRevision: 'f'.repeat(40) } },
      { ...value, mirror: { ...value.mirror, dependencyCachePath: '/workspace/node_modules' } },
      { ...value, profiles: [profile, profile] },
      withIdentity,
      {
        ...value,
        githubRead: {
          alias: 'github-read',
          bindingDigest: `sha256:${'b'.repeat(64)}`,
          repository: 'context-and/portfolio-simulation',
        },
      },
      { ...value, token: 'must-never-be-present' },
    ]) {
      expect(() => parseManagedProfileSetConfig(JSON.stringify(changed))).toThrow(
        'managed-profile-set-config-invalid',
      );
    }
  } finally {
    f.close();
  }
});
