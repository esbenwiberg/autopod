import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import Docker from 'dockerode';
import examples from '../../../../specs/managed-pod/v1/examples.json' with { type: 'json' };
import { digest } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import type { ProfileLlmClient } from '../providers/llm-client.js';
import { canaryLabel, dockerCanaryService } from './canary-docker-service.js';
import { LocalCheckpointHost } from './local-checkpoints.js';

const run = 'example';
const reports = [
  'MAPLE: The ticket total double-counts the first entry.',
  'CEDAR: Display formatting passes every check; no defect.',
  'IRIS: The archive export omits the final row.',
];
const mission =
  'At kickoff commission exactly six inspect workers for separate synthetic quality checks and wait for three results. When those reports arrive, commission one inspect follow-up for each distinct reported defect, naming its finding label and what to investigate in the brief. Do not follow up on clean checks. Then hand control back (waitFor null).';
// No hosted worker, application DB copy, workflow launch, HTTP endpoint or caller-selected prompt.
export async function runHostedWaveCanary(
  input: { state: string; migrations: string; socket: string; image: string },
  provider: ProfileLlmClient,
) {
  const { state, migrations, socket, image } = input;
  assert(path.isAbsolute(state) && path.isAbsolute(socket) && /^sha256:[a-f0-9]{64}$/.test(image));
  const docker = new Docker({ socketPath: socket, timeout: 15000 });
  assert.equal((await docker.getImage(image).inspect()).Id, image);
  // Deliberately not recursive: an existing directory means already attempted. Never resume or re-plan.
  await mkdir(state, { mode: 0o700 });
  const owner = randomUUID();
  await writeFile(path.join(state, 'owner'), owner, { flag: 'wx', mode: 0o600 });
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'ap-hosted-wave-'));
  const db = new Database(path.join(state, 'ledger.sqlite'));
  const list = () =>
    docker.listContainers({ all: true, filters: { label: [`${canaryLabel}=${owner}`] } });
  const active = async () =>
    (await Promise.all((await list()).map((c) => docker.getContainer(c.Id).inspect())))
      .filter((c) => c.State.Running)
      .map((c) => c.Id)
      .sort();
  try {
    db.pragma('foreign_keys=ON');
    const names = await readdir(migrations);
    for (const n of [
      142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 184, 185, 206, 262, 263, 264, 265,
      266, 267, 268,
    ]) {
      const matching = names.filter((p) => p.startsWith(`${n}_`) && p.endsWith('.sql'));
      assert.equal(matching.length, 1);
      const [file] = matching;
      assert(file);
      db.exec(await readFile(path.join(migrations, file), 'utf8'));
    }
    const source = path.join(root, 'source');
    await managedGit(root, ['init', '-b', 'main', source]);
    const commit = (message: string) =>
      managedGit(source, [
        '-c',
        'user.name=Canary',
        '-c',
        'user.email=canary@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        message,
      ]);
    await commit('base');
    const predecessor = await managedGit(source, ['rev-parse', 'HEAD']);
    await writeFile(path.join(source, 'proof.txt'), 'unpublished checkpoint\n');
    await managedGit(source, ['add', 'proof.txt']);
    await commit('synthetic fixture');
    const sha = await managedGit(source, ['rev-parse', 'HEAD']);
    const subject = {
      run,
      predecessor,
      commit: sha,
      tree: await managedGit(source, ['rev-parse', 'HEAD^{tree}']),
      repository: 'fixture-repo',
      policyDigest: digest('synthetic-canary'),
    };
    const req = structuredClone(examples.ManagedPodRequest) as ManagedPodRequest;
    const p = req.profileSnapshot;
    p.budget = req.effectiveGrant.budget = {
      mode: 'request-time',
      maxProviderRequests: 2,
      maxObservedTokens: 10000,
      maxDurationSeconds: 180,
      expiresAt: 400,
    };
    const [repo] = p.scope.repositories;
    assert(repo);
    repo.baseRevision = sha;
    req.effectiveGrant.scope = structuredClone(p.scope);
    req.outputs.artifacts.requiredPaths = ['report.md'];
    const hashExcept = (o: object, key: string) =>
      digest(Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)));
    p.snapshotDigest = req.effectiveGrant.profileSnapshotDigest = hashExcept(p, 'snapshotDigest');
    req.effectiveGrant.digest = hashExcept(req.effectiveGrant, 'digest');
    req.executionSpecDigest = hashExcept(req, 'executionSpecDigest');
    const compose = dockerCanaryService(db, root, docker, image, owner, p, true);
    const host = new LocalCheckpointHost(db, path.join(root, 'scratch'), (_cp, mirror) =>
      compose(mirror),
    );
    host.ledger.open(run, subject.repository, subject.policyDigest, predecessor, 18, 6);
    const bundle = path.join(root, 'source.bundle');
    await managedGit(source, ['bundle', 'create', bundle, 'HEAD']);
    const cp = await host.retain(subject, await readFile(bundle), async (s, mirror) => {
      assert.equal(
        await managedGit(mirror, ['show', `${s.commit}:proof.txt`]),
        'unpublished checkpoint',
      );
      return {
        subjectDigest: digest(s),
        checks: { status: 'passed', receiptDigest: digest('canary-check') },
        independentReview: { status: 'passed', receiptDigest: digest('canary-fixture-only') },
      };
    });
    await host.ledger.kickoff(cp, { inspect: req });
    const decision = (kickoff: boolean) =>
      JSON.parse(
        db
          .prepare(
            "SELECT decision_json FROM orchestration_controller_turns WHERE (wait_key='@kickoff')=?",
          )
          .pluck()
          .get(Number(kickoff)) as string,
      ) as { children: { brief: string }[]; waitFor: number | null };
    // Two bounded passes, each triggered by a concrete barrier. No polling or timer-based admission.
    const tick = () =>
      host.tickController(
        run,
        {
          mission,
          routeId: 'repofit-main',
          findings: 'report.md',
          recipes: { inspect: '@inspect' },
        },
        provider,
      );
    assert.deepEqual(await tick(), { blocked: [] });
    const first = await active();
    assert.equal(first.length, 6);
    assert.equal(decision(true).children.length, 6);
    assert.equal(decision(true).waitFor, 3);
    for (const [i, id] of first.slice(0, 3).entries()) {
      const report = reports[i];
      assert(report);
      await promisify(execFile)(
        'docker',
        [
          '--host',
          `unix://${socket}`,
          'exec',
          id,
          '/bin/sh',
          '-ec',
          'test -p /tmp/finish && printf "%s\\n" "$1" > /tmp/finish',
          'release',
          report,
        ],
        { env: { HOME: root, PATH: process.env.PATH }, timeout: 10000 },
      );
      assert.equal((await docker.getContainer(id).wait()).StatusCode, 0);
    }
    const service = compose();
    await service.enforceExpiry();
    await service.artifactPipeline?.tick();
    assert.deepEqual(await active(), first.slice(3));
    assert.deepEqual(await tick(), { blocked: [] });
    const plan = decision(false),
      briefs = plan.children.map((c) => c.brief);
    assert.equal(plan.waitFor, null);
    assert.equal(briefs.length, 2);
    assert.equal(
      briefs.filter(
        (b) => /\bMAPLE\b/i.test(b) && /double|count|total/i.test(b) && !/IRIS|CEDAR/i.test(b),
      ).length,
      1,
    );
    assert.equal(
      briefs.filter(
        (b) =>
          /\bIRIS\b/i.test(b) && /archive|export|final row/i.test(b) && !/MAPLE|CEDAR/i.test(b),
      ).length,
      1,
    );
    const live = await active();
    assert.equal(live.length, 5);
    assert.deepEqual(
      live.filter((id) => first.includes(id)),
      first.slice(3),
    );
    assert.equal((await list()).length, 8);
    assert.equal(
      db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get(),
      0,
    );
    host.ledger.cancel(run);
    await service.enforceExpiry();
    await service.enforceExpiry();
    assert.deepEqual(await active(), []);
    const calls = db
      .prepare("SELECT count(*) FROM orchestration_controller_turns WHERE status='decided'")
      .pluck()
      .get();
    const stopped = db
      .prepare("SELECT count(*) FROM managed_pods WHERE observed_exit=1 AND state='killed'")
      .pluck()
      .get();
    assert.equal(calls, 2);
    assert.equal(stopped, 5);
    return {
      workers: (await list()).length,
      originalSurvivors: live.filter((id) => first.includes(id)).length,
      calls,
      stopped,
    };
  } finally {
    db.close();
    for (const c of await list()) {
      assert.equal(c.Labels[canaryLabel], owner);
      await docker.getContainer(c.Id).remove({ force: true, v: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}
