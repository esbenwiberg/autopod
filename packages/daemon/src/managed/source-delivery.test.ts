import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FinalizeSourceDeliveryRequest, SourceCandidateReceipt } from '@autopod/shared';
import { expect, it } from 'vitest';
import { fixture, resign } from '../test-utils/managed-fixture.js';
import { digest, sha256 } from './canonical.js';
import { ManagedControls } from './managed-controls.js';
import { ManagedSourceDelivery } from './source-delivery.js';
import { type DraftRecord, ManagedGitBroker, ZERO_COMMIT } from './source-git.js';

async function sourceFixture(mode: 'branch' | 'draft-pr' = 'draft-pr') {
  const f = fixture();
  const root = mkdtempSync(path.join(tmpdir(), 'managed-source-'));
  const repo = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repo, 'answer.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', remote, 'main');
  writeFileSync(path.join(repo, 'answer.txt'), 'verified\n');
  git(repo, 'commit', '-am', 'candidate');
  const request = f.request;
  request.task.kind = 'implementation';
  request.outputs.source = {
    mode,
    repository: 'fixture-repo',
    remote: 'origin',
    head: 'worker/fixture',
    base: 'main',
  };
  request.outputs.artifacts.mode = 'optional';
  request.validation = { suite: 'full', verifierPolicy: 'fixture-full-v1' };
  const scope = request.profileSnapshot.scope;
  scope.repositories = [
    {
      enrollmentId: 'fixture-repo',
      remote: 'origin',
      baseRevision: base,
      branchNamespace: 'worker/',
      access: 'write',
    },
  ];
  scope.allowedEffects = [
    'git.commit',
    'git.push.worker-branch',
    'pull-request.create-draft',
    'pull-request.update-draft',
  ];
  request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(request.profileSnapshot).filter(([k]) => k !== 'snapshotDigest'),
    ),
  );
  request.effectiveGrant.profileSnapshotDigest = request.profileSnapshot.snapshotDigest;
  request.effectiveGrant.scope = structuredClone(scope);
  resign(request);
  f.admission.profiles = new Map([
    [request.profileSnapshot.snapshotDigest, request.profileSnapshot],
  ]);
  let pr: DraftRecord | null = null;
  let creates = 0;
  let updates = 0;
  const drafts = {
    async inspect() {
      return pr;
    },
    async create(r: FinalizeSourceDeliveryRequest) {
      creates++;
      pr = {
        id: 1,
        repository: r.repository,
        head: r.head,
        base: r.base,
        commit: r.newCommit,
        draft: true,
        bodyDigest: r.bodyDigest,
      };
      return pr;
    },
    async update(r: FinalizeSourceDeliveryRequest, old: DraftRecord) {
      updates++;
      pr = { ...old, bodyDigest: r.bodyDigest };
      return pr;
    },
  };
  const broker = new ManagedGitBroker([
    {
      repository: 'fixture-repo',
      remote: 'origin',
      remoteUrl: remote,
      base: 'main',
      baseCommit: base,
      branchNamespace: 'worker/',
      workspace: () => repo,
    },
  ]);
  let service = f.service();
  let delivery = new ManagedSourceDelivery(
    service,
    broker,
    new Map([['fixture-full-v1', 'dispatcher-verifier']]),
    drafts,
  );
  service.source = delivery;
  const handle = await service.start('installation-one', request);
  await f.runtime.stop(handle.podId);
  await service.enforceExpiry();
  const candidate = await delivery.freeze('installation-one', handle.podId);
  const v = {
    schemaVersion: 1 as const,
    verificationId: 'verification-one',
    dispatcherAttemptId: request.dispatcherAttemptId,
    executionSpecDigest: request.executionSpecDigest,
    candidateDigest: candidate.candidateDigest,
    newCommit: candidate.newCommit,
    evidenceDigest: candidate.evidenceDigest,
    verifierPolicy: 'fixture-full-v1',
    verifierIdentity: 'dispatcher-verifier',
    status: 'passed' as const,
    verifiedAt: 100,
  };
  const finalize: FinalizeSourceDeliveryRequest = {
    schemaVersion: 1,
    dispatcherInstallationId: 'installation-one',
    dispatcherAttemptId: request.dispatcherAttemptId,
    executionSpecDigest: request.executionSpecDigest,
    candidateDigest: candidate.candidateDigest,
    verificationReceipt: { ...v, receiptDigest: digest(v) },
    grantId: handle.grantId,
    grantRevision: handle.grantRevision,
    operation: mode,
    repository: candidate.repository,
    remote: candidate.remote,
    head: candidate.head,
    base: candidate.base,
    expectedOldCommit: candidate.expectedOldCommit,
    newCommit: candidate.newCommit,
    draft: true,
    bodyDigest: sha256(Buffer.from('fixture body')),
    operationKey: 'deliver-one',
  };
  return {
    f,
    root,
    repo,
    remote,
    git,
    request,
    handle,
    candidate,
    finalize,
    broker,
    get service() {
      return service;
    },
    get delivery() {
      return delivery;
    },
    creates: () => creates,
    updates: () => updates,
    setPr: (value: DraftRecord | null) => {
      pr = value;
    },
    getPr: () => pr,
    restart: () => {
      f.restart();
      service = f.service();
      delivery = new ManagedSourceDelivery(
        service,
        broker,
        new Map([['fixture-full-v1', 'dispatcher-verifier']]),
        drafts,
      );
      service.source = delivery;
    },
    close: () => {
      f.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each(['verification', 'remote', 'base', 'branch', 'candidate', 'stale', 'revoked', 'expired'])(
  'rejects %s before any source effect',
  async (kind) => {
    const f = await sourceFixture();
    try {
      const r = structuredClone(f.finalize);
      if (kind === 'verification') r.verificationReceipt.status = 'failed';
      if (kind === 'remote') r.remote = 'other';
      if (kind === 'base') r.base = 'other';
      if (kind === 'branch') r.head = 'main';
      if (kind === 'candidate') r.candidateDigest = `sha256:${'f'.repeat(64)}`;
      if (kind === 'stale') r.grantRevision++;
      if (kind === 'revoked') f.f.db.prepare('UPDATE managed_pods SET revoked=1').run();
      if (kind === 'expired') f.f.advance(4102444801);
      await expect(f.delivery.finalize('installation-one', f.handle.podId, r)).rejects.toThrow();
      expect(await f.broker.remoteHead(f.broker.binding(f.candidate), f.candidate.head)).toBe(
        ZERO_COMMIT,
      );
      expect(f.creates()).toBe(0);
    } finally {
      f.close();
    }
  },
);
it.each(['before-push', 'after-push', 'before-pr', 'after-pr', 'before-receipt', 'after-receipt'])(
  'reconciles %s through restart with one draft and no new worker',
  async (fault) => {
    const f = await sourceFixture();
    try {
      await expect(
        f.delivery.finalize('installation-one', f.handle.podId, f.finalize, fault),
      ).rejects.toThrow('injected');
      f.restart();
      const result = await f.delivery.finalize('installation-one', f.handle.podId, f.finalize);
      expect(result.receipts[0]?.newCommit).toBe(f.candidate.newCommit);
      expect(f.creates()).toBe(1);
      expect(f.f.launches()).toBe(1);
      f.f.db.prepare('UPDATE managed_pods SET revoked=1').run();
      expect(
        await f.delivery.finalize('installation-one', f.handle.podId, f.finalize),
      ).toMatchObject({ status: 'delivered' });
      await expect(
        f.delivery.finalize('installation-one', f.handle.podId, {
          ...f.finalize,
          bodyDigest: `sha256:${'0'.repeat(64)}`,
        }),
      ).rejects.toThrow('conflict');
    } finally {
      f.close();
    }
  },
);
it('concurrent finalizers converge, and a changed remote branch is never overwritten', async () => {
  const f = await sourceFixture('branch');
  try {
    const results = await Promise.all([
      f.delivery.finalize('installation-one', f.handle.podId, f.finalize),
      f.delivery.finalize('installation-one', f.handle.podId, f.finalize),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.creates()).toBe(0);
  } finally {
    f.close();
  }
  const changed = await sourceFixture('branch');
  try {
    changed.git(
      changed.repo,
      'push',
      changed.remote,
      `${changed.broker.binding(changed.candidate).baseCommit}:refs/heads/${changed.candidate.head}`,
    );
    await expect(
      changed.delivery.finalize('installation-one', changed.handle.podId, changed.finalize),
    ).rejects.toThrow('head-moved');
    expect(
      await changed.broker.remoteHead(
        changed.broker.binding(changed.candidate),
        changed.candidate.head,
      ),
    ).not.toBe(changed.candidate.newCommit);
  } finally {
    changed.close();
  }
});
it('preserves a draft that was marked ready and refuses changed frozen candidate replay', async () => {
  const f = await sourceFixture();
  try {
    await expect(
      f.delivery.finalize('installation-one', f.handle.podId, f.finalize, 'after-pr'),
    ).rejects.toThrow();
    f.setPr({ ...f.getPr()!, draft: false });
    f.restart();
    await expect(
      f.delivery.finalize('installation-one', f.handle.podId, f.finalize),
    ).rejects.toThrow('draft-changed');
    expect(f.creates()).toBe(1);
    const candidate = f.delivery.candidate('installation-one', f.handle.podId).receipt;
    expect(candidate).toEqual(f.candidate);
    f.f.db.prepare('UPDATE managed_source_candidates SET candidate_json=?').run(
      JSON.stringify({
        ...candidate,
        newCommit: 'f'.repeat(40),
      } satisfies SourceCandidateReceipt),
    );
    expect(() => f.delivery.candidate('installation-one', f.handle.podId)).toThrow('integrity');
  } finally {
    f.close();
  }
});
it('a worker URL rewrite after freeze cannot redirect the credentialed broker push', async () => {
  const f = await sourceFixture('branch');
  try {
    const other = path.join(f.root, 'other.git');
    f.git(f.root, 'init', '--bare', other);
    f.git(f.repo, 'config', `url.${other}.insteadOf`, f.remote);
    const result = await f.delivery.finalize('installation-one', f.handle.podId, f.finalize);
    expect(result.status).toBe('delivered');
    expect(await f.broker.remoteHead(f.broker.binding(f.candidate), f.candidate.head)).toBe(
      f.candidate.newCommit,
    );
    expect(
      f
        .git(f.root, '--git-dir', other, 'for-each-ref', '--format=%(objectname)', 'refs/heads/')
        .trim(),
    ).toBe('');
  } finally {
    f.close();
  }
});
it('cleanup cannot discard an unfrozen source candidate, and frozen source can deliver after cleanup', async () => {
  const f = await sourceFixture('branch');
  let cleanups = 0;
  try {
    f.f.runtime.cleanup = async () => {
      cleanups++;
      rmSync(f.repo, { recursive: true, force: true });
      return true;
    };
    const frozen = f.delivery.candidate('installation-one', f.handle.podId);
    f.f.db.prepare('DELETE FROM managed_source_candidates').run();
    const request = {
      schemaVersion: 1,
      dispatcherAttemptId: f.request.dispatcherAttemptId,
      grantId: f.handle.grantId,
      grantRevision: f.handle.grantRevision,
      operation: 'cleanup',
    };
    const controls = new ManagedControls(f.service);
    await expect(
      controls.control('installation-one', f.handle.podId, request, 'cleanup-one'),
    ).rejects.toThrow('candidate-unavailable');
    expect(cleanups).toBe(0);
    f.f.db
      .prepare('INSERT INTO managed_source_candidates VALUES (?,?,?)')
      .run(f.handle.podId, JSON.stringify(frozen.receipt), frozen.bundle);
    expect(
      await controls.control('installation-one', f.handle.podId, request, 'cleanup-one'),
    ).toMatchObject({ cleanup: 'observed' });
    expect((await f.delivery.finalize('installation-one', f.handle.podId, f.finalize)).status).toBe(
      'delivered',
    );
    expect(cleanups).toBe(1);
  } finally {
    f.close();
  }
});
