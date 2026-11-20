import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { digest, sha256 } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { combinedPolicyDigest } from './combined-attestation.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { inspectParentCandidate, readParentCandidate } from './parent-candidate-custody.js';
import { buildParentIntegration } from './parent-candidate-integration.js';
import {
  parentIntegrationGateDigest,
  qualifyParentIntegration,
} from './parent-integration-qualified.js';

type IntegrationInput = Readonly<{
  requestKey: string;
  candidateDigest: string;
  expectedTree: string;
  allowlist: readonly [{ readonly kind: 'file'; readonly path: string }];
}>;

// Private ledger fixture only; the live report catalog has no coding capability.
async function fixture(
  paths: readonly [string, string] = ['proof-one.txt', 'proof-two.txt'],
  origin: 'own' | 'foreign' = 'own',
) {
  const f = await setupOrchestrationRun(2, 1, 'coding-parent');
  const run = f.cp.run;
  const db = f.f.db;
  const checks = fixtureSigner('checks', 'fixture-parent-checks', digest('parent-checks/v1'));
  const independentReview = fixtureSigner(
    'independentReview',
    'fixture-parent-review',
    digest('parent-review/v1'),
  );
  const policy = {
    basePolicyDigest: f.cp.policyDigest,
    checks: checks.authority,
    independentReview: independentReview.authority,
  };
  const policyDigest = combinedPolicyDigest(policy);
  const cp = { ...f.cp, policyDigest };
  const baseBundle = path.join(f.root, 'base.bundle');
  await writeFile(baseBundle, f.bytes);

  db.prepare(
    'UPDATE orchestration_runs SET policy_digest=?,accepted_commit=?,accepted_evidence=? WHERE id=?',
  ).run(policyDigest, cp.commit, cp.evidenceDigest, run);
  db.prepare(
    'INSERT INTO parent_managed_runs(run_id,pod_id,launch_digest,policy_digest,policy_json) VALUES(?,?,?,?,?)',
  ).run(run, 'fixture-parent', digest('launch'), digest('policy'), '{}');
  if (origin === 'foreign') {
    db.prepare(`INSERT INTO orchestration_runs(id,repository,policy_digest,accepted_commit,worker_request_limit)
      SELECT 'foreign-run',repository,policy_digest,accepted_commit,worker_request_limit
      FROM orchestration_runs WHERE id=?`).run(run);
    db.prepare(`INSERT INTO parent_managed_runs(run_id,pod_id,launch_digest,policy_digest,policy_json)
      SELECT 'foreign-run','foreign-parent',launch_digest,policy_digest,policy_json
      FROM parent_managed_runs WHERE run_id=?`).run(run);
  }
  db.prepare(
    'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,1,?)',
  ).run('parent-session', origin === 'foreign' ? 'foreign-run' : run, 'parent-container');

  const createChild = async (index: 0 | 1) => {
    const ordinal = index + 1;
    const changedPath = paths[index];
    const repository = path.join(f.root, `candidate-repo-${ordinal}`);
    await managedGit(f.root, ['init', '-b', 'main', repository]);
    await managedGit(repository, ['bundle', 'unbundle', baseBundle]);
    await managedGit(repository, ['checkout', '--detach', f.cp.commit]);
    await writeFile(path.join(repository, changedPath), `tested candidate fixture ${ordinal}\n`);
    await managedGit(repository, ['add', '--', changedPath]);
    await managedGit(repository, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      `Scoped candidate ${ordinal}`,
    ]);
    const newCommit = await managedGit(repository, ['rev-parse', 'HEAD']);
    const tree = await managedGit(repository, ['rev-parse', 'HEAD^{tree}']);
    const file = path.join(f.root, `candidate-${ordinal}.bundle`);
    await managedGit(repository, ['bundle', 'create', file, 'HEAD']);
    const bundle = await readFile(file);
    const source = {
      mode: 'commit',
      repository: f.cp.repository,
      remote: 'private',
      head: `parent/result-${ordinal}`,
      base: 'main',
    };
    const executionSpecDigest = digest(`private-coding-spec-${ordinal}`);
    const podId = `fixture-coding-child-${ordinal}`;
    const dispatcherAttemptId = `fixture-child-attempt-${ordinal}`;
    const startKey = `fixture-child-start-${ordinal}`;
    const requestKey = `code-${ordinal}`;
    const request = JSON.stringify({ executionSpecDigest, outputs: { source } });
    db.prepare(`
      INSERT INTO managed_pods(pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,
        execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,effective_grant_digest,
        request_json,handle_json,state,observed_exit,created_at,exit_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'validated',1,100,0)
    `).run(
      podId,
      `native.${run}`,
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
      digest(`operation-${ordinal}`),
      JSON.stringify(cp),
      request,
      podId,
    );
    db.prepare(
      'INSERT INTO parent_managed_requests(run_id,start_key,request_key,parent_attempt,input_digest) VALUES(?,?,?,?,?)',
    ).run(run, startKey, requestKey, 'parent-session', digest(`input-${ordinal}`));
    const body = {
      schemaVersion: 1,
      candidateId: `candidate-${podId}`,
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
    const allowlist = [{ kind: 'file' as const, path: changedPath }] as const;
    const input: IntegrationInput = { requestKey, candidateDigest, expectedTree: tree, allowlist };
    return {
      bundle,
      receipt,
      selection: { requestKey, candidateDigest },
      input,
      tree,
      changedPath,
      podId,
    };
  };

  const children = [await createChild(0), await createChild(1)] as const;
  return { ...f, cp, db, run, children, policy, checks, independentReview };
}

function privateEffects(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    changes: f.db.prepare('SELECT total_changes()').pluck().get(),
    sourceOperations: f.db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get(),
    publicationTables: f.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%publication%' ORDER BY name",
      )
      .pluck()
      .all(),
    launches: f.f.launches(),
  };
}

async function expectIntegrationRefusal(
  f: Awaited<ReturnType<typeof fixture>>,
  inputs: readonly [IntegrationInput, IntegrationInput],
  error: string,
) {
  const before = privateEffects(f);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  try {
    await expect(
      buildParentIntegration(f.db, path.join(f.root, `refused-${error}`), f.run, inputs),
    ).rejects.toThrow(error);
    expect(network).not.toHaveBeenCalled();
    expect(privateEffects(f)).toEqual(before);
  } finally {
    network.mockRestore();
  }
}

it('reads a private candidate from the exact current parent run without mutating the ledger', async () => {
  const f = await fixture();
  const child = f.children[0];
  const dbChanges = f.db.prepare('SELECT total_changes()').pluck().get();
  expect(readParentCandidate(f.db, f.run, child.selection)).toEqual({
    receipt: child.receipt,
    bundle: child.bundle,
    base: f.cp.commit,
    authorityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  });
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(dbChanges);
  expect(f.db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get()).toBe(0);
  expect(f.f.launches()).toBe(0);
  expect(() => readParentCandidate(f.db, 'another-run', child.selection)).toThrow('unavailable');
  expect(() =>
    readParentCandidate(f.db, f.run, { ...child.selection, requestKey: 'foreign' }),
  ).toThrow('unavailable');
  expect(() =>
    readParentCandidate(f.db, f.run, {
      ...child.selection,
      candidateDigest: digest('wrong'),
    }),
  ).toThrow('binding');
});

it('rejects foreign origins but preserves earlier attempts from the same run', async () => {
  const foreign = await fixture(undefined, 'foreign');
  expect(() => readParentCandidate(foreign.db, foreign.run, foreign.children[0].selection)).toThrow(
    'unavailable',
  );
  const f = await fixture();
  const before = readParentCandidate(f.db, f.run, f.children[0].selection);
  f.db
    .prepare(
      'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,2,?)',
    )
    .run('fresh-session', f.run, 'fresh-container');
  f.db
    .prepare('UPDATE parent_managed_runs SET current_attempt=? WHERE run_id=?')
    .run('fresh-session', f.run);
  expect(readParentCandidate(f.db, f.run, f.children[0].selection)).toEqual(before);
});

it('imports only the retained bundle into a private mirror and verifies exact diff scope', async () => {
  const f = await fixture();
  const child = f.children[0];
  const scratch = path.join(f.root, 'private-inspection');
  const snapshot = await inspectParentCandidate(f.db, scratch, f.run, child.input);
  expect(snapshot).toEqual({
    base: f.cp.commit,
    candidate: child.receipt.newCommit,
    tree: child.tree,
    changedPaths: [child.changedPath],
    receipt: child.receipt,
    scopeDigest: digest(child.input.allowlist),
  });
  await expect(
    inspectParentCandidate(f.db, scratch, f.run, {
      ...child.input,
      allowlist: [{ kind: 'file', path: 'other.txt' }],
    }),
  ).rejects.toThrow('candidate-path-scope-');
  await expect(
    inspectParentCandidate(f.db, scratch, f.run, {
      ...child.input,
      expectedTree: 'a'.repeat(40),
    }),
  ).rejects.toThrow('checkpoint-source-mismatch');
});

it('builds one exact offline two-parent tree and a real HEAD bundle from disjoint children', async () => {
  const f = await fixture();
  const inputs = [f.children[0].input, f.children[1].input] as const;
  const before = privateEffects(f);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  let result: Awaited<ReturnType<typeof buildParentIntegration>>;
  try {
    result = await buildParentIntegration(
      f.db,
      path.join(f.root, 'private-integration'),
      f.run,
      inputs,
    );
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
  expect(privateEffects(f)).toEqual(before);

  const expected = path.join(f.root, 'expected-tree');
  await managedGit(f.root, ['init', '-b', 'main', expected]);
  await writeFile(path.join(f.root, 'expected.bundle'), f.bytes);
  await managedGit(expected, ['bundle', 'unbundle', path.join(f.root, 'expected.bundle')]);
  await managedGit(expected, ['checkout', '--detach', f.cp.commit]);
  for (const [index, child] of f.children.entries())
    await writeFile(
      path.join(expected, child.changedPath),
      `tested candidate fixture ${index + 1}\n`,
    );
  await managedGit(expected, ['add', '--', ...f.children.map((child) => child.changedPath)]);
  const expectedTree = await managedGit(expected, ['write-tree']);

  expect(result.base).toBe(f.cp.commit);
  expect(result.tree).toBe(expectedTree);
  expect(result.paths).toEqual(['proof-one.txt', 'proof-two.txt']);
  expect(result.bundleDigest).toBe(sha256(result.bundle));
  expect(result.inputs).toEqual(
    f.children.map((child) => ({
      requestKey: child.input.requestKey,
      candidateDigest: child.input.candidateDigest,
      expectedTree: child.tree,
      scopeDigest: digest(child.input.allowlist),
    })),
  );

  const finalBundle = path.join(f.root, 'integration.bundle');
  const imported = path.join(f.root, 'imported-integration');
  await writeFile(finalBundle, result.bundle);
  await managedGit(f.root, ['init', '--bare', imported]);
  await managedGit(imported, ['bundle', 'verify', finalBundle]);
  expect(await managedGit(imported, ['bundle', 'list-heads', finalBundle])).toBe(
    `${result.commit} HEAD`,
  );
  await managedGit(imported, ['bundle', 'unbundle', finalBundle]);
  expect(await managedGit(imported, ['rev-parse', `${result.commit}^{tree}`])).toBe(result.tree);
  expect(await managedGit(imported, ['rev-list', '--parents', '-n', '1', result.commit])).toBe(
    `${result.commit} ${f.children[0].receipt.newCommit} ${f.children[1].receipt.newCommit}`,
  );
  expect(await managedGit(imported, ['show', `${result.commit}:proof-one.txt`])).toBe(
    'tested candidate fixture 1',
  );
  expect(await managedGit(imported, ['show', `${result.commit}:proof-two.txt`])).toBe(
    'tested candidate fixture 2',
  );
});

it('qualifies exact integration bytes with independent offline gates without advancing or publishing', async () => {
  const f = await fixture();
  const inputs = [f.children[0].input, f.children[1].input] as const;
  const acceptedBefore = f.db
    .prepare('SELECT accepted_commit,accepted_evidence FROM orchestration_runs WHERE id=?')
    .get(f.run);
  const operationsBefore = f.db
    .prepare('SELECT count(*) FROM managed_source_operations')
    .pluck()
    .get();
  const seen: string[] = [];
  const checkpoint = await qualifyParentIntegration(
    f.db,
    f.host(),
    path.join(f.root, 'qualified-integration'),
    f.run,
    inputs,
    {
      policy: f.policy,
      checks: async (request, bundle) => {
        seen.push('checks');
        expect(request.subject.run).toBe(f.run);
        expect(request.subject.predecessor).toBe(f.cp.commit);
        expect(request.paths).toEqual(['proof-one.txt', 'proof-two.txt']);
        expect(request.bundleDigest).toBe(sha256(bundle));
        await withVerifiedCheckpointMirror(
          path.join(f.root, 'checks-import'),
          request.subject,
          bundle,
          async (mirror) => {
            expect(
              await managedGit(mirror, ['show', `${request.subject.commit}:proof-one.txt`]),
            ).toBe('tested candidate fixture 1');
            expect(
              await managedGit(mirror, ['show', `${request.subject.commit}:proof-two.txt`]),
            ).toBe('tested candidate fixture 2');
          },
        );
        return f.checks.attest({
          status: 'passed',
          inputDigest: parentIntegrationGateDigest(request),
          evidenceDigest: digest('offline-check-evidence'),
        });
      },
      independentReview: async (request, bundle) => {
        seen.push('independentReview');
        await withVerifiedCheckpointMirror(
          path.join(f.root, 'review-import'),
          request.subject,
          bundle,
          async (mirror) => {
            expect(
              await managedGit(mirror, ['rev-parse', `${request.subject.commit}^{tree}`]),
            ).toBe(request.subject.tree);
            expect(
              await managedGit(mirror, ['show', '-s', '--format=%P', request.subject.commit]),
            ).toBe(`${f.children[0].receipt.newCommit} ${f.children[1].receipt.newCommit}`);
          },
        );
        return f.independentReview.attest({
          status: 'passed',
          inputDigest: parentIntegrationGateDigest(request),
          evidenceDigest: digest('offline-review-evidence'),
        });
      },
    },
  );

  expect(seen).toEqual(['checks', 'independentReview']);
  expect(checkpoint).toMatchObject({
    run: f.run,
    repository: f.cp.repository,
    predecessor: f.cp.commit,
    policyDigest: combinedPolicyDigest(f.policy),
  });
  expect(checkpoint.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(
    f.db
      .prepare('SELECT accepted_commit,accepted_evidence FROM orchestration_runs WHERE id=?')
      .get(f.run),
  ).toEqual(acceptedBefore);
  expect(f.db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get()).toBe(
    operationsBefore,
  );
  expect(f.f.launches()).toBe(0);
});

it('rejects a shared evaluator callback before launching either check', async () => {
  const f = await fixture();
  const evaluate = vi.fn();
  await expect(
    qualifyParentIntegration(
      f.db,
      f.host(),
      path.join(f.root, 'same-evaluator'),
      f.run,
      [f.children[0].input, f.children[1].input],
      { policy: f.policy, checks: evaluate, independentReview: evaluate },
    ),
  ).rejects.toThrow('parent-integration-independent-evaluators-required');
  expect(evaluate).not.toHaveBeenCalled();
});

it('does not retain, advance, or publish an integration when independent review fails', async () => {
  const f = await fixture();
  const inputs = [f.children[0].input, f.children[1].input] as const;
  const acceptedBefore = f.db
    .prepare('SELECT accepted_commit,accepted_evidence FROM orchestration_runs WHERE id=?')
    .get(f.run);
  const custodyBefore = f.db
    .prepare('SELECT count(*) FROM orchestration_checkpoint_custody')
    .pluck()
    .get();
  await expect(
    qualifyParentIntegration(
      f.db,
      f.host(),
      path.join(f.root, 'failed-qualified-integration'),
      f.run,
      inputs,
      {
        policy: f.policy,
        checks: async (request) =>
          f.checks.attest({
            status: 'passed',
            inputDigest: parentIntegrationGateDigest(request),
            evidenceDigest: digest('passing-checks'),
          }),
        independentReview: async (request, bundle) => {
          await withVerifiedCheckpointMirror(
            path.join(f.root, 'failed-review-import'),
            request.subject,
            bundle,
            async (mirror) => {
              expect(
                await managedGit(mirror, ['show', `${request.subject.commit}:proof-two.txt`]),
              ).toBe('tested candidate fixture 2');
            },
          );
          return f.independentReview.attest({
            status: 'failed',
            inputDigest: parentIntegrationGateDigest(request),
            evidenceDigest: digest('review-failure'),
          });
        },
      },
    ),
  ).rejects.toThrow('independentReview-required');
  expect(
    f.db
      .prepare('SELECT accepted_commit,accepted_evidence FROM orchestration_runs WHERE id=?')
      .get(f.run),
  ).toEqual(acceptedBefore);
  expect(f.db.prepare('SELECT count(*) FROM orchestration_checkpoint_custody').pluck().get()).toBe(
    custodyBefore,
  );
  expect(f.db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get()).toBe(0);
});

it('refuses qualification when child authority becomes stale during a gate', async () => {
  const f = await fixture();
  const inputs = [f.children[0].input, f.children[1].input] as const;
  const acceptedBefore = f.db
    .prepare('SELECT accepted_commit,accepted_evidence FROM orchestration_runs WHERE id=?')
    .get(f.run);
  await expect(
    qualifyParentIntegration(
      f.db,
      f.host(),
      path.join(f.root, 'stale-qualified-integration'),
      f.run,
      inputs,
      {
        policy: f.policy,
        checks: async (request, bundle) => {
          await withVerifiedCheckpointMirror(
            path.join(f.root, 'stale-gate-import'),
            request.subject,
            bundle,
            async (mirror) => {
              expect(
                await managedGit(mirror, ['show', `${request.subject.commit}:proof-one.txt`]),
              ).toBe('tested candidate fixture 1');
            },
          );
          f.db
            .prepare('UPDATE managed_pods SET grant_revision=grant_revision+1 WHERE pod_id=?')
            .run(f.children[0].podId);
          return f.checks.attest({
            status: 'passed',
            inputDigest: parentIntegrationGateDigest(request),
            evidenceDigest: digest('stale-check-evidence'),
          });
        },
        independentReview: async (request) =>
          f.independentReview.attest({
            status: 'passed',
            inputDigest: parentIntegrationGateDigest(request),
            evidenceDigest: digest('unused-review-evidence'),
          }),
      },
    ),
  ).rejects.toThrow('parent-integration-stale');
  expect(
    f.db
      .prepare('SELECT accepted_commit,accepted_evidence FROM orchestration_runs WHERE id=?')
      .get(f.run),
  ).toEqual(acceptedBefore);
  expect(f.db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get()).toBe(0);
});

it('pins the same integration tree and commit for repeated ordered inputs', async () => {
  const f = await fixture();
  const inputs = [f.children[0].input, f.children[1].input] as const;
  const first = await buildParentIntegration(
    f.db,
    path.join(f.root, 'integration-first'),
    f.run,
    inputs,
  );
  const second = await buildParentIntegration(
    f.db,
    path.join(f.root, 'integration-second'),
    f.run,
    inputs,
  );
  expect(second.base).toBe(first.base);
  expect(second.tree).toBe(first.tree);
  expect(second.commit).toBe(first.commit);
  expect(second.paths).toEqual(first.paths);
  expect(second.inputs).toEqual(first.inputs);
});

it('refuses a changed checkpoint even when the accepted commit and both candidates stay identical', async () => {
  const f = await fixture();
  const pending = buildParentIntegration(f.db, path.join(f.root, 'moved-evidence'), f.run, [
    f.children[0].input,
    f.children[1].input,
  ]);
  const evidence = digest('replacement evidence over the same tree');
  f.db.transaction(() => {
    f.db
      .prepare('UPDATE orchestration_runs SET accepted_evidence=? WHERE id=?')
      .run(evidence, f.run);
    f.db
      .prepare(`UPDATE orchestration_continuations
      SET checkpoint_json=json_set(checkpoint_json,'$.evidenceDigest',?) WHERE run_id=?`)
      .run(evidence, f.run);
  })();
  await expect(pending).rejects.toThrow('parent-integration-stale');
});

it.each([
  'grant',
  'continuation',
] as const)('refuses changed %s during integration even when both candidate bytes and the base are unchanged', async (field) => {
  const f = await fixture();
  const pending = buildParentIntegration(f.db, path.join(f.root, 'moved-authority'), f.run, [
    f.children[0].input,
    f.children[1].input,
  ]);
  if (field === 'grant') {
    f.db
      .prepare('UPDATE managed_pods SET grant_revision=grant_revision+1 WHERE pod_id=?')
      .run(f.children[0].podId);
  } else {
    f.db
      .prepare('UPDATE orchestration_continuations SET operation_digest=? WHERE pod_id=?')
      .run(digest('different continuation authorization'), f.children[0].podId);
  }
  await expect(pending).rejects.toThrow('parent-integration-stale');
});

it('refuses overlapping child changes without ledger writes, launch, network, or publication', async () => {
  const f = await fixture(['shared.txt', 'shared.txt']);
  await expectIntegrationRefusal(
    f,
    [f.children[0].input, f.children[1].input],
    'parent-integration-overlap',
  );
});

it.each([
  'foreign',
  'wrong',
  'stale',
] as const)('refuses %s child input without ledger writes, launch, network, or publication', async (kind) => {
  const f = await fixture();
  const first = f.children[0].input;
  const second = f.children[1].input;
  let inputs: readonly [IntegrationInput, IntegrationInput] = [first, second];
  let error = 'parent-candidate-';
  if (kind === 'foreign') {
    inputs = [{ ...first, requestKey: 'foreign-request' }, second];
    error += 'unavailable';
  } else if (kind === 'wrong') {
    inputs = [{ ...first, candidateDigest: digest('wrong-candidate') }, second];
    error += 'binding';
  } else {
    f.db.prepare("UPDATE orchestration_runs SET accepted_evidence='stale' WHERE id=?").run(f.run);
    error += 'unavailable';
  }
  await expectIntegrationRefusal(f, inputs, error);
});

it('refuses substituted bundle bytes and receipt data even if the receipt is rehashed', async () => {
  const f = await fixture();
  const child = f.children[0];
  f.db
    .prepare('UPDATE managed_source_candidates SET bundle=? WHERE pod_id=?')
    .run(Buffer.from('different bundle'), child.podId);
  expect(() => readParentCandidate(f.db, f.run, child.selection)).toThrow('binding');
  const { candidateDigest: _, ...original } = child.receipt;
  const body = { ...original, dispatcherAttemptId: 'other-child-attempt' };
  const candidateDigest = digest(body);
  f.db
    .prepare('UPDATE managed_source_candidates SET bundle=?,candidate_json=? WHERE pod_id=?')
    .run(child.bundle, JSON.stringify({ ...body, candidateDigest }), child.podId);
  expect(() => readParentCandidate(f.db, f.run, { ...child.selection, candidateDigest })).toThrow(
    'binding',
  );
});

it('refuses a stopped, failed, stale, or detached worker', async () => {
  const f = await fixture();
  const child = f.children[0];
  for (const change of [
    'revoked=1',
    'stop_requested=1',
    'observed_exit=0',
    'exit_code=2',
    "state='running'",
    "dispatcher_attempt_id='detached'",
  ]) {
    f.db.exec('SAVEPOINT bad_worker');
    f.db.prepare(`UPDATE managed_pods SET ${change} WHERE pod_id=?`).run(child.podId);
    expect(() => readParentCandidate(f.db, f.run, child.selection)).toThrow('unavailable');
    f.db.exec('ROLLBACK TO bad_worker; RELEASE bad_worker');
  }
  f.db.prepare("UPDATE orchestration_runs SET accepted_evidence='stale' WHERE id=?").run(f.run);
  expect(() => readParentCandidate(f.db, f.run, child.selection)).toThrow('unavailable');
});
