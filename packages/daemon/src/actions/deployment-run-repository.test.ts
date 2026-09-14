import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createDeploymentRunRepository } from './deployment-run-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.close());
function fixture() {
  let time = new Date('2026-09-14T10:00:00Z');
  const ledger = createDeploymentRunRepository(db, () => time);
  const plan = {
    podId: 'pod',
    operationKey: 'deploy-1',
    ownerId: 'owner',
    targetId: 'production',
    repositoryId: 'repo',
    setupId: 'default',
    launchDigest: 'a'.repeat(64),
    sourceKind: 'published-default',
    sourceBranch: 'main',
    sourceCommit: 'b'.repeat(40),
    sourceDigest: 'c'.repeat(64),
    scriptDigest: 'd'.repeat(64),
    scriptPath: 'scripts/deploy.sh',
    args: [],
    image: `fixture@sha256:${'e'.repeat(64)}`,
    runnerDigest: 'e'.repeat(64),
    environmentDigest: 'f'.repeat(64),
    credentialRevisions: {},
    expiresAt: '2026-09-14T11:00:00.000Z',
  };
  return {
    ledger,
    plan,
    expire: () => {
      time = new Date('2026-09-14T11:00:01Z');
    },
  };
}
it('binds human approval to the exact source, script, environment and request', () => {
  const { ledger, plan } = fixture();
  const run = ledger.reserve(plan);
  expect(ledger.reserve(plan).id).toBe(run.id);
  expect(() => ledger.reserve({ ...plan, args: ['--different'] })).toThrow('different approval');
  expect(() => ledger.approve(run.id, '0'.repeat(64), 'owner')).toThrow('digest');
  expect(() => ledger.approve(run.id, run.digest, 'another-user')).toThrow('operator');
  expect(ledger.claim(run.id, run.digest, vi.fn())).toBe(false);
  ledger.approve(run.id, run.digest, 'owner');
  expect(ledger.claim(run.id, run.digest, vi.fn())).toBe(true);
  expect(ledger.claim(run.id, run.digest, vi.fn())).toBe(false);
});
it('does not let a new key or another pod bypass an uncertain deployment target', () => {
  const { ledger, plan } = fixture();
  const first = ledger.reserve(plan);
  ledger.approve(first.id, first.digest, 'owner');
  ledger.claim(first.id, first.digest, vi.fn());
  expect(ledger.recoverInterrupted()).toBe(1);
  expect(ledger.get(first.id).state).toBe('uncertain');
  const next = ledger.reserve({ ...plan, podId: 'another-pod', operationKey: 'different' });
  ledger.approve(next.id, next.digest, 'owner');
  expect(() => ledger.claim(next.id, next.digest, vi.fn())).toThrow('reconcile');
});
it('checks expiry and current authorization before claiming execution', () => {
  const { ledger, plan, expire } = fixture();
  const run = ledger.reserve(plan);
  ledger.approve(run.id, run.digest, 'owner');
  expect(() =>
    ledger.claim(run.id, run.digest, () => {
      throw new Error('revoked');
    }),
  ).toThrow('revoked');
  expect(ledger.get(run.id).state).toBe('approved');
  expire();
  expect(() => ledger.claim(run.id, run.digest, vi.fn())).toThrow('expired');
  expect(ledger.deny(run.id, run.digest, 'owner').state).toBe('denied');
});
it('requires matching recorded process ownership and confirmed removal before settlement', () => {
  const { ledger, plan } = fixture();
  const run = ledger.reserve(plan);
  ledger.approve(run.id, run.digest, 'owner');
  ledger.claim(run.id, run.digest, vi.fn());
  const receipt = { exitCode: 0, outputBytes: 100, containerRemoved: true as const };
  expect(() => ledger.finish(run.id, receipt)).toThrow('execution identity');
  ledger.recordContainer(run.id, '1'.repeat(64));
  const identity = {
    backend: 'docker' as const,
    containerId: '1'.repeat(64),
    execId: '2'.repeat(64),
    pidPath: '/tmp/.autopod-stream-exec-fixture.pid',
  };
  expect(() => ledger.recordExec(run.id, { ...identity, containerId: '3'.repeat(64) })).toThrow(
    'ownership',
  );
  ledger.recordExec(run.id, identity);
  expect(ledger.finish(run.id, receipt).state).toBe('completed');
  expect(() => ledger.finish(run.id, receipt)).toThrow('execution identity');
  expect(() => db.prepare('DELETE FROM deployment_runs WHERE id=?').run(run.id)).toThrow(
    'retained',
  );
});
