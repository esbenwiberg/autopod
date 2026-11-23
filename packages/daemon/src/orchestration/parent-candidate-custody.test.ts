import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import Docker from 'dockerode';
import Fastify from 'fastify';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import { ManagedContainerRuntime } from '../managed/container-runtime.js';
import { managedGit } from '../managed/source-git.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { combinedPolicyDigest } from './combined-attestation.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import {
  inspectParentCandidate,
  readParentCandidate,
  retainParentWorkerCandidate,
} from './parent-candidate-custody.js';
import { buildParentIntegration } from './parent-candidate-integration.js';
import { createParentEvaluatorClient } from './parent-evaluator-client.js';
import { ParentEvaluatorVeto, parentExactTreeEvaluator } from './parent-exact-tree-evaluator.js';
import {
  parentIntegrationGateDigest,
  qualifyParentIntegration,
  readQualifiedParentIntegration,
} from './parent-integration-qualified.js';
import { parentQualificationJob } from './parent-qualification-job.js';
import { ParentReviewHandoff, registerParentReviewRoutes } from './parent-review-handoff.js';

type IntegrationInput = Readonly<{
  requestKey: string;
  candidateDigest: string;
  expectedTree: string;
  allowlist: readonly { readonly kind: 'file'; readonly path: string }[];
}>;

// Private ledger fixture only; the live report catalog has no coding capability.
async function fixture(
  paths: readonly [string, string] = ['proof-one.txt', 'proof-two.txt'],
  origin: 'own' | 'foreign' = 'own',
  scheduled: boolean | 'disjoint' = false,
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
  ).run('parent-session', run, 'parent-container');

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
    await managedGit(repository, ['-c', 'pack.window=0', 'bundle', 'create', file, 'HEAD']);
    const exported = await readFile(file);
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
        request_json,handle_json,state,observed_exit,created_at,exit_code,runtime_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'validating',1,100,0,?)
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
      `fixture-runtime-${ordinal}`,
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
    const allowlist = (scheduled === true ? paths : [changedPath]).map((path) => ({
      kind: 'file' as const,
      path,
    }));
    db.prepare(
      'INSERT INTO parent_managed_requests(run_id,start_key,request_key,parent_attempt,input_digest,private_scope_json) VALUES(?,?,?,?,?,?)',
    ).run(
      run,
      startKey,
      requestKey,
      'parent-session',
      digest(`input-${ordinal}`),
      scheduled ? canonical(allowlist) : null,
    );
    const exportPrivateHead = vi.fn(async (_ref: string) => ({
      commit: newCommit,
      tree,
      bundle: exported,
    }));
    const retain = () =>
      retainParentWorkerCandidate(
        db,
        path.join(f.root, 'private-export'),
        { exportPrivateHead },
        run,
        requestKey,
        allowlist,
      );
    const { bundle, receipt } = await retain();
    const { candidateDigest } = receipt;
    const input: IntegrationInput = { requestKey, candidateDigest, expectedTree: tree, allowlist };
    return {
      bundle,
      receipt,
      selection: { requestKey, candidateDigest },
      input,
      tree,
      changedPath,
      podId,
      retain,
      exportPrivateHead,
      repository,
      executionSpecDigest,
    };
  };

  const children = [await createChild(0), await createChild(1)] as const;
  if (origin === 'foreign') {
    db.prepare(
      'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,1,?)',
    ).run('foreign-session', 'foreign-run', 'foreign-container');
    db.prepare(`INSERT OR REPLACE INTO parent_managed_requests
      (run_id, start_key, request_key, parent_attempt, input_digest)
      SELECT run_id, start_key, request_key, 'foreign-session', input_digest
      FROM parent_managed_requests WHERE run_id=?`).run(run);
  }
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

const dockerImage = process.env.AUTOPOD_PARENT_PRIVATE_DOCKER_IMAGE;
it.skipIf(!dockerImage)(
  'retains a real no-network Docker worker commit after supervisor exit',
  async () => {
    if (!dockerImage || !/^sha256:[a-f0-9]{64}$/.test(dockerImage))
      throw new Error('fixture image must be pinned');
    const f = await fixture();
    const child = f.children[0];
    const docker = new Docker({ socketPath: process.env.AUTOPOD_MANAGED_DOCKER_SOCKET });
    const manager = new DockerContainerManager({ docker, logger: pino({ level: 'silent' }) });
    const box = await docker.createContainer({
      Image: dockerImage,
      Entrypoint: ['sleep', '90'],
      HostConfig: {
        NetworkMode: 'none',
        Binds: [`${await realpath(child.repository)}:/seed:ro`],
      },
    });
    try {
      await box.start();
      const repo = `/repositories/${f.cp.repository}`;
      const state = `/run/dispatcher-${child.podId}`;
      const source = {
        mode: 'commit' as const,
        repository: f.cp.repository,
        remote: child.receipt.remote,
        base: child.receipt.base,
        head: child.receipt.head,
      };
      const spec = f.f.request;
      const request: ManagedPodRequest = {
        ...spec,
        route: { ...spec.route, executionTarget: 'local' },
        outputs: { ...spec.outputs, source },
        executionSpecDigest: child.executionSpecDigest,
        effectiveGrant: {
          ...spec.effectiveGrant,
          scope: {
            ...spec.effectiveGrant.scope,
            network: { ...spec.effectiveGrant.scope.network, destinations: [] },
            identityBindings: [],
            allowedEffects: ['repository.read', 'repository.write'],
            repositories: [
              { enrollmentId: f.cp.repository, access: 'write', baseRevision: f.cp.commit },
            ],
          },
        },
      };
      f.db.transaction(() => {
        f.db.prepare('DELETE FROM parent_private_candidates WHERE pod_id=?').run(child.podId);
        f.db
          .prepare(
            'UPDATE managed_pods SET observed_exit=0,exit_code=NULL,state=?,runtime_ref=?,request_json=? WHERE pod_id=?',
          )
          .run('running', box.id, JSON.stringify(request), child.podId);
        f.db
          .prepare('UPDATE orchestration_continuations SET request_json=? WHERE pod_id=?')
          .run(JSON.stringify(request), child.podId);
      })();
      const runtime = new ManagedContainerRuntime(
        [
          {
            manager,
            route: request.route,
            image: dockerImage,
            command: [],
            prepare: async () => {
              throw new Error('unexpected fixture allocation');
            },
            quotaReady: async () => false,
            attachProviderChannel: async () => {
              throw new Error('unexpected provider attachment');
            },
          },
        ],
        (ref) =>
          ref === box.id
            ? {
                request,
                podId: child.podId,
                createdAt: 100,
                observedExit: Boolean(
                  f.db
                    .prepare('SELECT observed_exit FROM managed_pods WHERE pod_id=?')
                    .pluck()
                    .get(child.podId),
                ),
              }
            : null,
      );
      const retain = () =>
        retainParentWorkerCandidate(
          f.db,
          f.root,
          runtime,
          f.run,
          child.selection.requestKey,
          child.input.allowlist,
        );
      await expect(retain()).rejects.toThrow('parent-candidate-unavailable');

      const worker = `import subprocess,sys
base,name=sys.argv[1:]
git=['git','-c','user.name=Real Docker Fixture','-c','user.email=fixture@autopod.invalid']
subprocess.run(git+['checkout','--detach',base],check=True)
with open(name,'w') as f:f.write('written inside the isolated worker\\n')
subprocess.run(git+['add','--',name],check=True)
subprocess.run(git+['commit','-m','Worker commit'],check=True)
with open(name,'w') as f:f.write('dirty and intentionally not exported\\n')
`;
      const launch = {
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        maxDurationSeconds: 30,
        specDigest: child.executionSpecDigest,
        argv: ['python3', '-I', '-c', worker, f.cp.commit, child.changedPath],
        cwd: repo,
        environment: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: '/tmp' },
        workerUid: 1000,
        workerGid: 1000,
        requireQuotaReceipt: false,
      };
      const supervisor = await readFile(
        new URL('../managed/runtime/supervisor.py', import.meta.url),
        'utf8',
      );
      const prepare = `import os,shutil,sys
repo,state,launch=sys.argv[1:]
shutil.copytree('/seed',repo)
os.makedirs(state,mode=0o700)
with open(state+'/launch.json','w') as f:f.write(launch)
for root,dirs,files in os.walk(repo):
 os.chown(root,1000,1000)
 for name in files:os.chown(os.path.join(root,name),1000,1000)
`;
      expect(
        await manager.execInContainer(
          box.id,
          ['python3', '-I', '-c', prepare, repo, state, JSON.stringify(launch)],
          {
            user: 'root',
            requireObservedExit: true,
          },
        ),
      ).toMatchObject({ exitCode: 0 });
      expect(
        await manager.execInContainer(box.id, ['python3', '-I', '-c', supervisor, state], {
          user: 'root',
          requireObservedExit: true,
          timeout: 30_000,
        }),
      ).toMatchObject({ exitCode: 0 });
      await f.f.service(runtime).enforceExpiry();
      expect(
        f.db
          .prepare('SELECT observed_exit, exit_code, state FROM managed_pods WHERE pod_id=?')
          .get(child.podId),
      ).toEqual({ observed_exit: 1, exit_code: 0, state: 'validating' });
      const binding = {
        podId: child.podId,
        specDigest: child.executionSpecDigest,
        repository: f.cp.repository,
        base: f.cp.commit,
        maxBytes: 1024 * 1024,
      };
      const exec = vi.spyOn(manager, 'execInContainer');
      const scope = request.effectiveGrant.scope;
      try {
        await expect(
          runtime.exportPrivateHead(box.id, { ...binding, base: '0'.repeat(40) }, () => {}),
        ).rejects.toThrow('parent-private-export-runtime-binding');
        scope.repositories.push({
          enrollmentId: 'other',
          access: 'read',
          baseRevision: f.cp.commit,
        });
        await expect(retain()).rejects.toThrow('parent-private-export-runtime-binding');
        scope.repositories.pop();
        scope.identityBindings.push({
          alias: 'fixture',
          bindingDigest: digest('fixture identity'),
        });
        await expect(retain()).rejects.toThrow('parent-private-export-runtime-binding');
        scope.identityBindings.pop();
        scope.network.destinations.push('example.invalid');
        await expect(retain()).rejects.toThrow('parent-private-export-runtime-binding');
        scope.network.destinations.pop();
        scope.allowedEffects.push('artifact.write');
        await expect(retain()).rejects.toThrow('parent-private-export-runtime-binding');
        scope.allowedEffects.pop();
        source.remote = 'different';
        await expect(retain()).rejects.toThrow('parent-private-export-runtime-binding');
        source.remote = 'private';
        expect(exec).not.toHaveBeenCalled();
      } finally {
        exec.mockRestore();
      }
      const retained = await retain();
      expect(retained.receipt.newCommit).not.toBe(child.receipt.newCommit);
      expect(
        await withVerifiedCheckpointMirror(
          f.root,
          { predecessor: f.cp.commit, commit: retained.receipt.newCommit, tree: retained.tree },
          retained.bundle,
          (git) => managedGit(git, ['show', `${retained.receipt.newCommit}:${child.changedPath}`]),
        ),
      ).toBe('written inside the isolated worker');
    } finally {
      await box.remove({ force: true });
    }
  },
  60_000,
);

it('replays retained custody without rereading the runtime or granting legacy source authority', async () => {
  const f = await fixture();
  const child = f.children[0];
  const retained = await child.retain();
  expect(retained.receipt).toEqual(child.receipt);
  expect(child.exportPrivateHead).toHaveBeenCalledTimes(1);
  expect(child.exportPrivateHead.mock.calls[0]?.[0]).toBe('fixture-runtime-1');
  expect(f.db.prepare('SELECT count(*) FROM managed_source_candidates').pluck().get()).toBe(0);
  expect(
    f.db.prepare('SELECT state FROM managed_pods WHERE pod_id=?').pluck().get(child.podId),
  ).toBe('validating');
  await expect(
    retainParentWorkerCandidate(
      f.db,
      f.root,
      { exportPrivateHead: child.exportPrivateHead },
      f.run,
      child.selection.requestKey,
      [{ kind: 'file', path: 'another.txt' }],
    ),
  ).rejects.toThrow('parent-candidate-scope-mismatch');
});

it.each([
  'stop_requested=1',
  "runtime_ref='replacement-runtime'",
])('refuses to retain a verified export if authority changes during collection: %s', async (change) => {
  const f = await fixture();
  const child = f.children[0];
  f.db.prepare('DELETE FROM parent_private_candidates WHERE pod_id=?').run(child.podId);
  const pending = retainParentWorkerCandidate(
    f.db,
    f.root,
    { exportPrivateHead: child.exportPrivateHead },
    f.run,
    child.selection.requestKey,
    child.input.allowlist,
  );
  f.db.prepare(`UPDATE managed_pods SET ${change} WHERE pod_id=?`).run(child.podId);
  await expect(pending).rejects.toThrow('parent-candidate-stale');
  expect(
    f.db.prepare('SELECT 1 FROM parent_private_candidates WHERE pod_id=?').get(child.podId),
  ).toBeUndefined();
});

it('reads a private candidate from the exact current parent run without mutating the ledger', async () => {
  const f = await fixture();
  const child = f.children[0];
  const dbChanges = f.db.prepare('SELECT total_changes()').pluck().get();
  expect(readParentCandidate(f.db, f.run, child.selection)).toEqual({
    receipt: child.receipt,
    bundle: child.bundle,
    base: f.cp.commit,
    tree: child.tree,
    scopeDigest: digest(child.input.allowlist),
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
  ).rejects.toThrow('parent-candidate-scope-mismatch');
  await expect(
    inspectParentCandidate(f.db, scratch, f.run, {
      ...child.input,
      expectedTree: 'a'.repeat(40),
    }),
  ).rejects.toThrow('parent-candidate-scope-mismatch');
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
  f.f.restart();
  const db = f.f.db;
  const retained = readQualifiedParentIntegration(db, f.run, checkpoint.evidenceDigest);
  expect(retained.checkpoint).toEqual(checkpoint);
  expect(retained.gateRequest.paths).toEqual(['proof-one.txt', 'proof-two.txt']);
  expect(retained.checks.status).toBe('passed');
  expect(retained.independentReview.status).toBe('passed');
  expect(() =>
    readQualifiedParentIntegration(db, 'foreign-run', checkpoint.evidenceDigest),
  ).toThrow('parent-integration-custody-unavailable');
  // The digest match and a claimed outer status cannot turn a signed veto into a pass.
  const stored = db
    .prepare(
      'SELECT manifest,bundle FROM orchestration_checkpoint_custody WHERE run_id=? AND evidence_digest=?',
    )
    .get(f.run, checkpoint.evidenceDigest) as { manifest: string; bundle: Buffer };
  const manifest = JSON.parse(stored.manifest);
  const veto = f.independentReview.attest({
    status: 'failed',
    inputDigest: parentIntegrationGateDigest(retained.gateRequest),
    evidenceDigest: digest('fixture-review-veto'),
  });
  manifest.verification.independentReview = {
    status: 'passed',
    receipt: veto,
    receiptDigest: digest(veto),
  };
  const substituted = JSON.stringify(manifest);
  db.prepare('INSERT INTO orchestration_checkpoint_custody VALUES (?,?,?,?)').run(
    f.run,
    sha256(substituted),
    substituted,
    stored.bundle,
  );
  expect(() => readQualifiedParentIntegration(db, f.run, sha256(substituted))).toThrow(
    'combined-independentReview-required',
  );
  db.prepare(
    'UPDATE orchestration_checkpoint_custody SET bundle=? WHERE run_id=? AND evidence_digest=?',
  ).run(Buffer.from('corrupt fixture'), f.run, checkpoint.evidenceDigest);
  expect(() => readQualifiedParentIntegration(db, f.run, checkpoint.evidenceDigest)).toThrow(
    'parent-integration-custody-binding',
  );
});

it('evaluates the exact tree and releases just the approved bundle to the enrolled reviewer', async () => {
  const f = await fixture();
  const scratch = path.join(f.root, 'review-handoff');
  const tested: string[] = [];
  const checks = parentExactTreeEvaluator(path.join(scratch, 'checks'), f.policy, 'checks', {
    async evaluate({ mirror, commit, tree }) {
      for (const [i, file] of ['proof-one.txt', 'proof-two.txt'].entries())
        expect(await managedGit(mirror, ['show', `${commit}:${file}`])).toBe(
          `tested candidate fixture ${i + 1}`,
        );
      tested.push(tree);
      return {
        status: 'passed',
        evidence: Buffer.from(`two content assertions passed for ${tree}`),
      };
    },
    async sign(statement) {
      const { inputDigest, status, evidenceDigest } = statement;
      return f.checks.attest({ inputDigest, status, evidenceDigest });
    },
  });
  const independentReview = parentExactTreeEvaluator(
    path.join(scratch, 'review'),
    f.policy,
    'independentReview',
    {
      async evaluate({ mirror, commit, tree, predecessor }) {
        expect(
          await managedGit(mirror, [
            'diff-tree',
            '--no-commit-id',
            '--name-only',
            '-r',
            predecessor,
            commit,
          ]),
        ).toBe('proof-one.txt\nproof-two.txt');
        tested.push(tree);
        return { status: 'passed', evidence: Buffer.from(`scope reviewed for ${tree}`) };
      },
      async sign(statement) {
        const { inputDigest, status, evidenceDigest } = statement;
        return f.independentReview.attest({ inputDigest, status, evidenceDigest });
      },
    },
  );
  const checkpoint = await qualifyParentIntegration(
    f.db,
    f.host(),
    scratch,
    f.run,
    [f.children[0].input, f.children[1].input],
    { policy: f.policy, checks, independentReview },
  );
  expect(tested).toEqual([checkpoint.tree, checkpoint.tree]);
  const qualified = readQualifiedParentIntegration(f.db, f.run, checkpoint.evidenceDigest);
  await expect(checks(qualified.gateRequest, Buffer.from('not the tested bundle'))).rejects.toThrow(
    'parent-evaluator-bundle-digest',
  );
  await expect(
    checks(
      {
        ...qualified.gateRequest,
        subject: { ...qualified.gateRequest.subject, tree: 'a'.repeat(40) },
      },
      qualified.bundle,
    ),
  ).rejects.toThrow('checkpoint-source-mismatch');
  expect(tested).toHaveLength(2);

  const owner = { run: f.run, podId: 'fixture-parent', actorDigest: digest('enrolled reviewer') };
  const routes = (handoff: ParentReviewHandoff) => {
    const app = Fastify();
    registerParentReviewRoutes(app, handoff, async (request, podId) =>
      podId === owner.podId && request.headers.authorization === 'Bearer reviewer-fixture'
        ? owner
        : null,
    );
    return app;
  };
  const evidence = checkpoint.evidenceDigest;
  const url = `/orchestration/parents/${owner.podId}/review/${encodeURIComponent(evidence)}`;
  const headers = { authorization: 'Bearer reviewer-fixture' };
  const app = routes(new ParentReviewHandoff(f.db));
  let approval: unknown;
  try {
    expect((await app.inject(url + '/preview')).statusCode).toBe(404);
    expect((await app.inject({ url: url + '/bundle', headers })).statusCode).toBe(409);
    const preview = await app.inject({ url: url + '/preview', headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.json()).toMatchObject({
      commit: checkpoint.commit,
      tree: checkpoint.tree,
      evidenceDigest: evidence,
    });
    const approve = (expectedReviewDigest: string) =>
      app.inject({
        method: 'POST',
        url: url + '/approve',
        headers,
        payload: { evidenceDigest: evidence, expectedReviewDigest },
      });
    expect((await approve(digest('stale preview'))).statusCode).toBe(409);
    expect(f.db.prepare('SELECT count(*) FROM parent_review_approvals').pluck().get()).toBe(0);
    const accepted = await approve(preview.json().reviewDigest);
    expect(accepted.statusCode).toBe(200);
    approval = accepted.json();
    expect((await approve(preview.json().reviewDigest)).json()).toEqual(approval);
  } finally {
    await app.close();
  }
  f.f.restart();
  const db = f.f.db;
  const restarted = routes(new ParentReviewHandoff(db));
  try {
    const downloaded = await restarted.inject({ url: url + '/bundle', headers });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(qualified.bundle);
    expect(downloaded.headers['x-autopod-bundle-digest']).toBe(sha256(qualified.bundle));
    expect(db.prepare('SELECT count(*) FROM parent_review_approvals').pluck().get()).toBe(1);
    expect(db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get()).toBe(0);
    expect(
      db.prepare('SELECT accepted_commit FROM orchestration_runs WHERE id=?').pluck().get(f.run),
    ).toBe(f.cp.commit);
    const revised = await qualifyParentIntegration(
      db,
      f.host(),
      scratch,
      f.run,
      [f.children[1].input, f.children[0].input],
      { policy: f.policy, checks, independentReview },
    );
    expect(revised.evidenceDigest).not.toBe(evidence);
    const revisedUrl = `/orchestration/parents/${owner.podId}/review/${encodeURIComponent(revised.evidenceDigest)}`;
    expect((await restarted.inject({ url: revisedUrl + '/bundle', headers })).statusCode).toBe(409);
    const revisedPreview = await restarted.inject({ url: revisedUrl + '/preview', headers });
    expect(revisedPreview.statusCode).toBe(200);
    const approvedRevision = await restarted.inject({
      url: revisedUrl + '/approve',
      method: 'POST',
      headers,
      payload: {
        evidenceDigest: revised.evidenceDigest,
        expectedReviewDigest: revisedPreview.json().reviewDigest,
      },
    });
    expect(approvedRevision.statusCode).toBe(200);
    expect(db.prepare('SELECT count(*) FROM parent_review_approvals').pluck().get()).toBe(2);
    expect((await restarted.inject({ url: revisedUrl + '/bundle', headers })).statusCode).toBe(200);

    db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(f.children[0].podId);
    expect((await restarted.inject({ url: url + '/bundle', headers })).statusCode).toBe(409);
    expect((await restarted.inject({ url: revisedUrl + '/bundle', headers })).statusCode).toBe(409);
  } finally {
    await restarted.close();
  }
});

it.each([
  [false, true],
  [true, true],
  [false, 'disjoint'],
] as const)(
  'qualifies one completed pair; no replay after restart (lost reply: %s, scopes: %s)',
  async (loseReply, scopes) => {
    const f = await fixture(undefined, 'own', scopes);
    const endpoints = {
      checks: 'https://checks.fixture.example/verify',
      independentReview: 'https://review.fixture.example/verify',
    };
    const call = vi.fn<typeof fetch>(async (destination, options) => {
      expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
      const role = destination === endpoints.checks ? 'checks' : 'independentReview';
      expect(destination).toBe(endpoints[role]);
      const row = f.db
        .prepare(
          'SELECT status, input_digest AS inputDigest FROM parent_qualification_jobs WHERE run_id=?',
        )
        .get(f.run);
      const { request, bundle } = JSON.parse(String(options?.body));
      expect(row).toEqual({ status: role, inputDigest: parentIntegrationGateDigest(request) });
      expect(sha256(Buffer.from(bundle, 'base64'))).toBe(request.bundleDigest);
      if (loseReply) throw new Error('fixture lost reply');
      const receipt = await parentExactTreeEvaluator(f.root, f.policy, role, {
        async evaluate({ mirror, commit }) {
          const files = await managedGit(mirror, ['ls-tree', '--name-only', commit]);
          expect(files).toBe('proof-one.txt\nproof-two.txt\nproof.txt');
          return { status: 'passed', evidence: Buffer.from(files) };
        },
        async sign({ inputDigest, status, evidenceDigest }) {
          return f[role].attest({ inputDigest, status, evidenceDigest });
        },
      })(request, Buffer.from(bundle, 'base64'));
      return Response.json(receipt);
    });
    const job = (db = f.db) =>
      parentQualificationJob(
        db,
        f.host(),
        f.root,
        f.run,
        scopes === 'disjoint' ? ['proof-one.txt'] : ['proof-one.txt', 'proof-two.txt'],
        createParentEvaluatorClient(endpoints, f.policy, call),
        scopes === 'disjoint' ? ['proof-two.txt'] : undefined,
      );
    const initial = job();
    initial.recover();
    await initial.tick();
    expect(call).not.toHaveBeenCalled();
    const complete = (podId: string) =>
      f.db
        .transaction(() => {
          f.db.prepare("UPDATE managed_pods SET state='complete' WHERE pod_id=?").run(podId);
          initial.reserve();
        })
        .immediate();
    complete(f.children[0].podId);
    // A completed candidate is not enough if the other coding result is unavailable.
    const beforeRestartOwner = {
      run: f.run,
      podId: 'fixture-parent',
      actorDigest: digest('fixture reviewer'),
    };
    const recovery = new ParentReviewHandoff(f.db);
    f.db
      .prepare("UPDATE managed_pods SET state='review_required' WHERE pod_id=?")
      .run(f.children[1].podId);
    expect(recovery.familyReview(beforeRestartOwner, true)).toEqual({
      status: 'candidate-unavailable',
    });
    expect(recovery.familyReview(beforeRestartOwner, false)).toEqual({ status: 'not-configured' });
    await initial.tick();
    expect(call).not.toHaveBeenCalled();
    complete(f.children[1].podId);
    expect(f.db.prepare('SELECT status FROM parent_qualification_jobs').pluck().get()).toBe(
      'reserved',
    );
    await Promise.all([initial.tick(), initial.tick()]);
    expect(call).toHaveBeenCalledTimes(loseReply ? 1 : 2);
    expect(call.mock.calls.map(([url]) => url)).toEqual(
      loseReply ? [endpoints.checks] : [endpoints.checks, endpoints.independentReview],
    );
    const owner = { run: f.run, podId: 'fixture-parent', actorDigest: digest('fixture reviewer') };
    f.f.restart();
    const db = f.f.db;
    const reopened = job(db);
    reopened.recover();
    await reopened.tick();
    expect(call).toHaveBeenCalledTimes(loseReply ? 1 : 2);
    const handoff = new ParentReviewHandoff(db);
    const result = handoff.qualification(owner);
    expect(result.status).toBe(loseReply ? 'unknown' : 'ready');
    if (!loseReply) {
      const preview = handoff.preview(owner, result.evidenceDigest!);
      expect(preview.paths).toEqual(['proof-one.txt', 'proof-two.txt']);
      expect(handoff.familyReview(owner, true)).toEqual({
        status: 'ready',
        evidenceDigest: result.evidenceDigest,
        commit: preview.commit,
      });
      expect(() => handoff.download(owner, result.evidenceDigest!)).toThrow('approval-required');
      db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(f.children[0].podId);
      expect(handoff.familyReview(owner, true)).toEqual({ status: 'unavailable' });
    } else {
      expect(result.evidenceDigest).toBeNull();
      expect(handoff.familyReview(owner, true)).toEqual({ status: 'unknown' });
    }
  },
  12_000,
);

it('retains a trusted check veto as failed, without review or another dispatch', async () => {
  const f = await fixture(undefined, 'own', true);
  const checks = vi.fn().mockRejectedValue(new ParentEvaluatorVeto('checks'));
  const independentReview = vi.fn();
  const job = parentQualificationJob(
    f.db,
    f.host(),
    f.root,
    f.run,
    ['proof-one.txt', 'proof-two.txt'],
    { policy: f.policy, checks, independentReview },
  );
  f.db
    .prepare("UPDATE managed_pods SET state='complete' WHERE pod_id IN (?,?)")
    .run(...f.children.map((child) => child.podId));
  job.reserve();
  await job.tick();
  expect(
    f.db.prepare('SELECT status FROM parent_qualification_jobs WHERE run_id=?').pluck().get(f.run),
  ).toBe('failed');
  job.recover();
  job.reserve();
  await job.tick();
  expect(checks).toHaveBeenCalledOnce();
  expect(independentReview).not.toHaveBeenCalled();
});

it('records a pre-send reservation as not sent and starts no work on daemon recovery', async () => {
  const f = await fixture(undefined, 'own', true);
  const scratch = path.join(f.root, 'reserved-restart');
  const checks = vi.fn();
  const independentReview = vi.fn();
  const current = (db: typeof f.db) =>
    parentQualificationJob(db, f.host(), scratch, f.run, ['proof-one.txt', 'proof-two.txt'], {
      policy: f.policy,
      checks,
      independentReview,
    });
  const first = current(f.db);
  f.db.prepare("UPDATE managed_pods SET state='complete'").run();
  first.reserve();
  expect(f.db.prepare('SELECT status FROM parent_qualification_jobs').pluck().get()).toBe(
    'reserved',
  );
  f.f.restart();
  const reopened = current(f.f.db);
  reopened.recover();
  await reopened.tick();
  expect(f.f.db.prepare('SELECT status FROM parent_qualification_jobs').pluck().get()).toBe(
    'not-sent',
  );
  expect(checks).not.toHaveBeenCalled();
  expect(independentReview).not.toHaveBeenCalled();
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
    .prepare('UPDATE parent_private_candidates SET bundle=? WHERE pod_id=?')
    .run(Buffer.from('different bundle'), child.podId);
  expect(() => readParentCandidate(f.db, f.run, child.selection)).toThrow('binding');
  const { candidateDigest: _, ...original } = child.receipt;
  const body = { ...original, dispatcherAttemptId: 'other-child-attempt' };
  const candidateDigest = digest(body);
  f.db
    .prepare('UPDATE parent_private_candidates SET bundle=?,candidate_json=? WHERE pod_id=?')
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
