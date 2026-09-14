import type { EffectiveLaunchConfig, RepositoryConfig } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createDeploymentRunRepository } from './deployment-run-repository.js';
import { createDeploymentService, deploymentTargetSchema } from './deployment-service.js';
import type { IsolatedDeploymentInput } from './isolated-deploy-runner.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.close());
async function archive(content: string) {
  const stream = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (part: unknown) => {
      if (Buffer.isBuffer(part)) chunks.push(part);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  stream.entry({ name: 'deploy.sh', mtime: new Date(0) }, content);
  stream.finalize();
  return done;
}
async function fixture() {
  const { services } = createTestConfiguration(db);
  const config: EffectiveLaunchConfig = await resolveLaunch(
    { repositoryId: 'repo-a', task: 'Deploy published code' },
    services,
  );
  if (!config.repository) throw new Error('Missing fixture repository');
  config.repository.setup.integrations.deployment = {
    enabled: true,
    source: 'published-default',
    targetId: 'production',
    env: {},
    allowedScripts: ['deploy.sh'],
  };
  let target = deploymentTargetSchema.parse({
    id: 'production',
    repositoryId: 'repo-a',
    setupId: 'default',
    image: `fixture@sha256:${'a'.repeat(64)}`,
    allowedScripts: ['deploy.sh'],
  });
  let revoked = false;
  let credentialRevision = 1;
  const publishedDefault = vi.fn(async () => ({ branch: 'main', commit: 'b'.repeat(40) }));
  const read = vi.fn(async (_repository: RepositoryConfig, _commit: string) =>
    archive('echo published\n'),
  );
  const credentials = vi.fn(async () => ({ FIXTURE_TOKEN: 'fake-secret' }));
  const execute = vi.fn(async (_target: unknown, input: IsolatedDeploymentInput) => {
    input.assertCurrent();
    input.recordContainer('1'.repeat(64));
    input.recordExec({
      backend: 'docker',
      containerId: '1'.repeat(64),
      execId: '2'.repeat(64),
      pidPath: '/tmp/.autopod-stream-exec-fixture.pid',
    });
    return { exitCode: 0, outputBytes: 20, containerRemoved: true as const };
  });
  const runs = createDeploymentRunRepository(db);
  const stop = vi.fn(async () => {});
  const service = createDeploymentService({
    runs,
    context: () => ({ config, ownerId: 'owner' }),
    target: () => target,
    assertCurrent() {
      if (revoked) throw new Error('revoked');
    },
    publishedDefault,
    archive: read,
    credentials,
    credentialRevisions: () => ({ fixture: credentialRevision }),
    run: execute,
    stop,
  });
  return {
    config,
    service,
    runs,
    publishedDefault,
    read,
    credentials,
    execute,
    stop,
    revoke: () => {
      revoked = true;
    },
    rotate: () => {
      credentialRevision++;
    },
    changeTarget: () => {
      target = { ...target, timeoutMs: 1000 };
    },
  };
}
const request = { operationKey: 'deploy-once', scriptPath: 'deploy.sh', args: ['--production'] };
it('pins latest published default once and executes only its reviewed commit, despite branch advancement', async () => {
  const f = await fixture();
  const run = await f.service.prepare('pod', request);
  expect(run.plan.sourceKind).toBe('published-default');
  expect(f.credentials).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  f.publishedDefault.mockResolvedValue({ branch: 'changed-default', commit: 'c'.repeat(40) });
  expect((await f.service.prepare('pod', request)).id).toBe(run.id);
  const review = await f.service.review(run.id, 'owner');
  expect(review.scriptContent).toBe('echo published\n');
  expect(f.credentials).not.toHaveBeenCalled();
  await f.service.decide(run.id, run.digest, 'owner', 'approve');
  const completed = await f.service.settled(run.id);
  expect(completed.state).toBe('completed');
  expect(completed.receipt?.exitCode).toBe(0);
  expect(f.publishedDefault).toHaveBeenCalledOnce();
  expect(f.read.mock.calls.every((call) => call[1] === 'b'.repeat(40))).toBe(true);
  expect(await f.service.decide(run.id, run.digest, 'owner', 'approve')).toEqual(completed);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(JSON.stringify(completed)).not.toContain('fake-secret');
});
it('rejects another owner, source overrides, changed arguments and runner settings before execution', async () => {
  const f = await fixture();
  await expect(f.service.prepare('pod', request, 'other')).rejects.toThrow('another operator');
  expect(f.publishedDefault).not.toHaveBeenCalled();
  await expect(f.service.prepare('pod', { ...request, source: 'pod' })).rejects.toThrow();
  const run = await f.service.prepare('pod', request);
  await expect(f.service.prepare('pod', { ...request, args: [] })).rejects.toThrow('different');
  await expect(f.service.decide(run.id, run.digest, 'other', 'approve')).rejects.toThrow(
    'another operator',
  );
  await expect(f.service.decide(run.id, '0'.repeat(64), 'owner', 'approve')).rejects.toThrow(
    'digest',
  );
  f.changeTarget();
  await expect(f.service.decide(run.id, run.digest, 'owner', 'approve')).rejects.toThrow(
    'authority changed',
  );
  expect(f.execute).not.toHaveBeenCalled();
});
it('retains an uncertain target after lost execution acknowledgement, and recovery never re-executes', async () => {
  const f = await fixture();
  const run = await f.service.prepare('pod', request);
  f.execute.mockRejectedValue(new Error('lost Docker acknowledgement with sensitive output'));
  expect((await f.service.decide(run.id, run.digest, 'owner', 'approve')).state).toBe('running');
  expect((await f.service.settled(run.id)).state).toBe('uncertain');
  await f.service.recover();
  expect(f.stop).toHaveBeenCalledOnce();
  const next = await f.service.prepare('pod', { ...request, operationKey: 'new-key' });
  await expect(f.service.decide(next.id, next.digest, 'owner', 'approve')).rejects.toThrow(
    'reconcile',
  );
  expect(f.execute).toHaveBeenCalledOnce();
  const reconciled = await f.service.reconcile(
    run.id,
    run.digest,
    'owner',
    'not-deployed',
    'Checked fixture destination; no deployment exists',
  );
  expect(reconciled.state).toBe('reconciled');
  expect(reconciled.receipt).toBeNull();
  expect(reconciled.reconciliation?.actorId).toBe('owner');
});
it('rechecks credential acquisition and exact archive bytes before running', async () => {
  const f = await fixture();
  const run = await f.service.prepare('pod', request);
  f.credentials.mockImplementation(async () => {
    f.revoke();
    return { FIXTURE_TOKEN: 'fake-secret' };
  });
  expect((await f.service.decide(run.id, run.digest, 'owner', 'approve')).state).toBe('running');
  expect((await f.service.settled(run.id)).state).toBe('uncertain');
  expect(f.execute).not.toHaveBeenCalled();
});
it('refuses changed pinned source without exposing credentials and allows closing a denied request', async () => {
  const f = await fixture();
  const run = await f.service.prepare('pod', request);
  f.read.mockImplementation(async () => archive('echo changed\n'));
  await expect(f.service.review(run.id, 'owner')).rejects.toThrow('source changed');
  expect(f.credentials).not.toHaveBeenCalled();
  expect((await f.service.decide(run.id, run.digest, 'owner', 'deny')).state).toBe('denied');
  await expect(f.service.decide(run.id, run.digest, 'owner', 'approve')).rejects.toThrow(
    'no longer',
  );
});

it('invalidates pending approval when a referenced deployment credential is rotated', async () => {
  const f = await fixture();
  const run = await f.service.prepare('pod', request);
  expect(run.plan.credentialRevisions).toEqual({ fixture: 1 });
  f.rotate();
  await expect(f.service.decide(run.id, run.digest, 'owner', 'approve')).rejects.toThrow(
    'authority changed',
  );
  expect(f.credentials).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  const next = await f.service.prepare('pod', { ...request, operationKey: 'after-rotation' });
  expect(next.plan.credentialRevisions).toEqual({ fixture: 2 });
});
