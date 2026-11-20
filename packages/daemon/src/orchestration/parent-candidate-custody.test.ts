import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { digest, sha256 } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { inspectParentCandidate, readParentCandidate } from './parent-candidate-custody.js';

// Private ledger fixture only; the live report catalog has no coding capability.
async function fixture() {
  const f = await setupOrchestrationRun(2, 1, 'coding-parent');
  const run = f.cp.run;
  const db = f.f.db;
  const repository = path.join(f.root, 'candidate-repo');
  await writeFile(path.join(f.root, 'base.bundle'), f.bytes);
  await managedGit(f.root, ['init', '-b', 'main', repository]);
  await managedGit(repository, ['bundle', 'unbundle', path.join(f.root, 'base.bundle')]);
  await managedGit(repository, ['checkout', '--detach', f.cp.commit]);
  await writeFile(path.join(repository, 'proof.txt'), 'tested candidate fixture\n');
  await managedGit(repository, ['add', '--', 'proof.txt']);
  await managedGit(repository, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Scoped candidate',
  ]);
  const newCommit = await managedGit(repository, ['rev-parse', 'HEAD']);
  const tree = await managedGit(repository, ['rev-parse', 'HEAD^{tree}']);
  const file = path.join(f.root, 'candidate.bundle');
  await managedGit(repository, ['bundle', 'create', file, 'HEAD']);
  const bundle = await readFile(file);
  const source = {
    mode: 'commit',
    repository: f.cp.repository,
    remote: 'private',
    head: 'parent/result',
    base: 'main',
  };
  const executionSpecDigest = digest('private-coding-spec');
  const podId = 'fixture-coding-child';
  const dispatcherAttemptId = 'fixture-child-attempt';
  const startKey = 'fixture-child-start';
  const requestKey = 'code-one';
  const request = JSON.stringify({ executionSpecDigest, outputs: { source } });
  db.prepare(`
    INSERT INTO managed_pods(pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,
      execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,effective_grant_digest,
      request_json,handle_json,state,observed_exit,created_at,exit_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'validated',1,100,0)
  `).run(
    podId,
    'native.' + run,
    dispatcherAttemptId,
    startKey,
    executionSpecDigest,
    digest('profile'),
    'grant',
    1,
    digest('grant'),
    request,
    '{}',
  );
  db.prepare(`
    INSERT INTO orchestration_continuations(run_id,start_key,attempt_id,operation_digest,checkpoint_json,request_json,reserved_requests,pod_id)
    VALUES (?,?,?,?,?,?,2,?)
  `).run(
    run,
    startKey,
    dispatcherAttemptId,
    digest('operation'),
    JSON.stringify(f.cp),
    request,
    podId,
  );
  db.prepare('UPDATE orchestration_runs SET accepted_commit=?,accepted_evidence=? WHERE id=?').run(
    f.cp.commit,
    f.cp.evidenceDigest,
    run,
  );
  db.prepare(
    'INSERT INTO parent_managed_runs(run_id,pod_id,launch_digest,policy_digest,policy_json) VALUES(?,?,?,?,?)',
  ).run(run, 'fixture-parent', digest('launch'), digest('policy'), '{}');
  db.prepare(
    'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,1,?)',
  ).run('parent-session', run, 'parent-container');
  db.prepare(
    'INSERT INTO parent_managed_requests(run_id,start_key,request_key,parent_attempt,input_digest) VALUES(?,?,?,?,?)',
  ).run(run, startKey, requestKey, 'parent-session', digest('input'));
  const body = {
    schemaVersion: 1,
    candidateId: 'candidate-' + podId,
    podId,
    dispatcherAttemptId,
    executionSpecDigest,
    repository: source.repository,
    remote: source.remote,
    head: source.head,
    base: source.base,
    expectedOldCommit: '0'.repeat(40),
    newCommit,
    evidenceDigest: sha256(bundle),
  };
  const candidateDigest = digest(body);
  const receipt = { ...body, candidateDigest };
  db.prepare(
    'INSERT INTO managed_source_candidates(pod_id,candidate_json,bundle) VALUES(?,?,?)',
  ).run(podId, JSON.stringify(receipt), bundle);
  return {
    ...f,
    db,
    bundle,
    receipt,
    run,
    selection: { requestKey, candidateDigest },
    tree,
    podId,
  };
}

it('reads a private candidate from the exact current parent run without mutating the ledger', async () => {
  const f = await fixture();
  const dbChanges = f.db.prepare('SELECT total_changes()').pluck().get();
  expect(readParentCandidate(f.db, f.run, f.selection)).toEqual({
    receipt: f.receipt,
    bundle: f.bundle,
    base: f.cp.commit,
  });
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(dbChanges);
  expect(f.db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get()).toBe(0);
  expect(f.f.launches()).toBe(0);
  expect(() => readParentCandidate(f.db, 'another-run', f.selection)).toThrow('unavailable');
  expect(() => readParentCandidate(f.db, f.run, { ...f.selection, requestKey: 'foreign' })).toThrow(
    'unavailable',
  );
  expect(() =>
    readParentCandidate(f.db, f.run, { ...f.selection, candidateDigest: digest('wrong') }),
  ).toThrow('binding');
});

it('imports only the retained bundle into a private mirror and verifies exact diff scope', async () => {
  const f = await fixture();
  const scratch = path.join(f.root, 'private-inspection');
  const input = {
    ...f.selection,
    expectedTree: f.tree,
    allowlist: [{ kind: 'file' as const, path: 'proof.txt' }],
  };
  const snapshot = await inspectParentCandidate(f.db, scratch, f.run, input);
  expect(snapshot).toEqual({
    base: f.cp.commit,
    candidate: f.receipt.newCommit,
    tree: f.tree,
    changedPaths: ['proof.txt'],
    receipt: f.receipt,
    scopeDigest: digest(input.allowlist),
  });
  await expect(
    inspectParentCandidate(f.db, scratch, f.run, {
      ...input,
      allowlist: [{ kind: 'file', path: 'other.txt' }],
    }),
  ).rejects.toThrow('candidate-path-scope-');
  await expect(
    inspectParentCandidate(f.db, scratch, f.run, { ...input, expectedTree: 'a'.repeat(40) }),
  ).rejects.toThrow('checkpoint-source-mismatch');
});

it('refuses substituted bundle bytes and receipt data even if the receipt is rehashed', async () => {
  const f = await fixture();
  f.db
    .prepare('UPDATE managed_source_candidates SET bundle=?')
    .run(Buffer.from('different bundle'));
  expect(() => readParentCandidate(f.db, f.run, f.selection)).toThrow('binding');
  const { candidateDigest: _, ...original } = f.receipt;
  const body = { ...original, dispatcherAttemptId: 'other-child-attempt' };
  const candidateDigest = digest(body);
  f.db
    .prepare('UPDATE managed_source_candidates SET bundle=?,candidate_json=?')
    .run(f.bundle, JSON.stringify({ ...body, candidateDigest }));
  expect(() => readParentCandidate(f.db, f.run, { ...f.selection, candidateDigest })).toThrow(
    'binding',
  );
});

it('refuses a stopped, failed, stale, or detached worker', async () => {
  const f = await fixture();
  for (const change of [
    'revoked=1',
    'stop_requested=1',
    'observed_exit=0',
    'exit_code=2',
    "state='running'",
    "dispatcher_attempt_id='detached'",
  ]) {
    f.db.exec('SAVEPOINT bad_worker');
    f.db.exec('UPDATE managed_pods SET ' + change);
    expect(() => readParentCandidate(f.db, f.run, f.selection)).toThrow('unavailable');
    f.db.exec('ROLLBACK TO bad_worker; RELEASE bad_worker');
  }
  f.db.prepare("UPDATE orchestration_runs SET accepted_evidence='stale' WHERE id=?").run(f.run);
  expect(() => readParentCandidate(f.db, f.run, f.selection)).toThrow('unavailable');
});
