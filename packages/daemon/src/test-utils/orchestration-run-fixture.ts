import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import { LocalCheckpointHost } from '../orchestration/local-checkpoints.js';
import { requestTimeFixture, resign } from './managed-fixture.js';

export async function setupOrchestrationRun(
  workerRequests = 2,
  maxActive = 1,
  run = 'example',
  policyDigest = digest('fixture-policy'),
) {
  const f = requestTimeFixture(2);
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'native-run-'));
  onTestFinished(async () => {
    f.close();
    await rm(root, { recursive: true, force: true });
  });
  f.db.exec(
    await readFile(
      new URL('../db/migrations/262_orchestration_continuations.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/263_orchestration_checkpoint_custody.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/265_orchestration_waves.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/266_orchestration_controller_turns.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/267_orchestration_unknown_outcomes.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/268_orchestration_kickoffs.sql', import.meta.url),
      'utf8',
    ),
  );
  const source = path.join(root, 'retained');
  const commit = async (message: string) =>
    managedGit(source, [
      '-c',
      'user.email=f@example.invalid',
      '-c',
      'user.name=Fixture',
      'commit',
      '--allow-empty',
      '-m',
      message,
    ]);
  await managedGit(root, ['init', '-b', 'main', source]);
  await commit('base');
  const predecessor = await managedGit(source, ['rev-parse', 'HEAD']);
  await writeFile(path.join(source, 'proof.txt'), 'unpublished checkpoint\n');
  await managedGit(source, ['add', 'proof.txt']);
  await commit('verified');
  const sha = await managedGit(source, ['rev-parse', 'HEAD']);
  const subject = {
    run,
    predecessor,
    commit: sha,
    tree: await managedGit(source, ['rev-parse', 'HEAD^{tree}']),
    repository: 'fixture-repo',
    policyDigest,
  };
  const request = f.request;
  request.outputs.artifacts.mode = 'none';
  const profile = request.profileSnapshot;
  const repo = profile.scope.repositories[0];
  if (!repo) throw new Error('missing fixture repo');
  repo.baseRevision = sha;
  request.effectiveGrant.scope = structuredClone(profile.scope);
  const { snapshotDigest: _, ...fields } = profile;
  profile.snapshotDigest = request.effectiveGrant.profileSnapshotDigest = digest(fields);
  resign(request);
  f.admission.profiles = new Map([[profile.snapshotDigest, profile]]);
  const host = () =>
    new LocalCheckpointHost(f.db, path.join(root, 'scratch'), (_cp, mirror) =>
      f.service({
        ...f.runtime,
        ensure: async (id, spec, checkpoint, fault) => {
          const pin = spec.effectiveGrant.scope.repositories[0]?.baseRevision;
          if (!pin) throw new Error('missing-pin');
          const cwd = path.join(root, id);
          await managedGit(root, ['clone', '--no-local', '--no-checkout', mirror, cwd]);
          await managedGit(cwd, ['checkout', '--detach', pin]);
          expect(await managedGit(cwd, ['rev-parse', 'HEAD'])).toBe(cp.commit);
          expect(await readFile(path.join(cwd, 'proof.txt'), 'utf8')).toBe(
            'unpublished checkpoint\n',
          );
          return f.runtime.ensure(id, spec, checkpoint, fault);
        },
      }),
    );
  const ledger = () => host().ledger;
  ledger().open(
    subject.run,
    subject.repository,
    subject.policyDigest,
    predecessor,
    workerRequests,
    maxActive,
  );
  const file = path.join(root, 'retention.bundle');
  await managedGit(source, ['bundle', 'create', file, 'HEAD']);
  const bytes = await readFile(file);
  const verify = async (s: typeof subject, mirror: string) => {
    expect(await managedGit(mirror, ['show', `${s.commit}:proof.txt`])).toBe(
      'unpublished checkpoint',
    );
    return {
      subjectDigest: digest(s),
      checks: { status: 'passed' as const, receiptDigest: digest('fixture-checks') },
      independentReview: { status: 'passed' as const, receiptDigest: digest('fixture-review') },
    };
  };
  const cp = await host().retain(subject, bytes, verify);
  await rm(source, { recursive: true });
  await rm(file);
  return { f, root, cp, request, ledger, host, subject, bytes, verify };
}
