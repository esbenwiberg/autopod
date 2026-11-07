import { describe, expect, it } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';

async function fixture() {
  const f = createAdmissionFixture();
  const n = await f.native();
  const request = {
    emptyWorkspace: true,
    profileId: 'profile',
    task: 'Inspect the reference PNG using a native image tool; save research-output.md',
    overrides: { workflow: { output: 'artifact', validationPhases: [] } },
  };
  const original = await resolveLaunch(request, n.services);
  const sourceId = n.admit(original).podId;
  const rerunRequest = {
    ...request,
    work: {
      intentionalRerun: {
        ofPodId: sourceId,
        requestKey: 'repeat-image-smoke',
        reason: 'Human requested repeating this read-only image smoke test',
      },
    },
  };
  const resolve = () => resolveLaunch(rerunRequest, n.services);
  const admit = async () => {
    const config = await resolve();
    return n.snapshots.admit({
      config,
      requestId: 'repeat-image-smoke-launch',
      requestDigest: config.digest,
      createPod: () =>
        f.resolved().createResolvedSession(config, 'operator', undefined, {
          type: 'human',
          userId: 'operator',
        }).id,
    });
  };
  return {
    f,
    n,
    original,
    sourceId,
    rerunRequest,
    resolve,
    admit,
    initialCount: f.podRepo.list().length,
  };
}

describe('audited explicit empty-workspace reruns', () => {
  it('creates a distinct task with a non-Git identity, preserves the original and replays exactly once', async () => {
    const { f, n, sourceId, admit, initialCount } = await fixture();
    const original = f.podRepo.getOrThrow(sourceId);
    const rerun = await admit();
    expect(rerun.podId).not.toBe(sourceId);
    expect(f.podRepo.taskExecutions?.snapshot(rerun.podId).taskId).not.toBe(
      f.podRepo.taskExecutions?.snapshot(sourceId).taskId,
    );
    expect(
      f.db
        .prepare(
          'SELECT source_pod_id,source_repository,source_base_branch,actor FROM execution_rerun_intents WHERE pod_id=?',
        )
        .get(rerun.podId),
    ).toEqual({
      source_pod_id: sourceId,
      source_repository: 'empty-workspace',
      source_base_branch: 'empty-workspace',
      actor: JSON.stringify({ type: 'human', userId: 'operator' }),
    });
    expect(f.podRepo.dispatchPreflight?.latest(rerun.podId)).toBeNull();
    expect(
      f.db
        .prepare(
          'SELECT * FROM execution_dispatch_bindings WHERE execution_id IN (SELECT execution_id FROM task_executions WHERE pod_id IN (?,?))',
        )
        .all(sourceId, rerun.podId),
    ).toEqual([]);
    expect(n.snapshots.get(rerun.podId)?.repository).toBeNull();
    expect(f.podRepo.getOrThrow(sourceId)).toEqual(original);
    expect(await admit()).toEqual({ podId: rerun.podId, created: false });
    expect(f.podRepo.list()).toHaveLength(initialCount + 1);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([
    'missing',
    'corrupt',
    'oversized',
    'unbound',
  ])('never infers an empty historical repository from %s launch evidence', async (kind) => {
    const { f, sourceId, admit, initialCount, original } = await fixture();
    if (kind === 'unbound')
      f.db.prepare('UPDATE pods SET launch_config_digest=NULL WHERE id=?').run(sourceId);
    if (kind === 'missing')
      f.db.prepare('DELETE FROM pod_launch_snapshots WHERE pod_id=?').run(sourceId);
    if (kind === 'corrupt')
      f.db
        .prepare(
          "UPDATE pod_launch_snapshots SET payload=json_set(payload,'$.task','tampered') WHERE pod_id=?",
        )
        .run(sourceId);
    if (kind === 'oversized')
      f.db
        .prepare('UPDATE pod_launch_snapshots SET payload=? WHERE pod_id=?')
        .run(JSON.stringify({ ...original, padding: ' '.repeat(1048577) }), sourceId);
    await expect(admit()).rejects.toMatchObject({ code: 'DISPATCH_IDENTITY_UNAVAILABLE' });
    expect(f.podRepo.list()).toHaveLength(initialCount);
    expect(f.db.prepare('SELECT * FROM execution_rerun_intents').all()).toEqual([]);
  });

  it('rejects a Git destination for an empty source and an empty destination for a Git source', async () => {
    const { f, n, sourceId, rerunRequest, initialCount } = await fixture();
    const git = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: rerunRequest.task,
        overrides: rerunRequest.overrides,
        work: rerunRequest.work,
      },
      n.services,
    );
    expect(() => n.admit(git)).toThrow('cannot change repository/empty-workspace scope');
    expect(f.podRepo.list()).toHaveLength(initialCount);
    const gitSource = n.admit(
      await resolveLaunch({ repositoryId: 'repo-a', task: rerunRequest.task }, n.services),
    );
    const empty = await resolveLaunch(
      {
        ...rerunRequest,
        work: {
          intentionalRerun: { ...rerunRequest.work.intentionalRerun, ofPodId: gitSource.podId },
        },
      },
      n.services,
    );
    expect(() => n.admit(empty)).toThrow('cannot change repository/empty-workspace scope');
    expect(f.podRepo.list()).toHaveLength(initialCount + 1);
    expect(f.db.prepare('SELECT * FROM execution_rerun_intents').all()).toEqual([]);
    expect(f.podRepo.getOrThrow(sourceId).launchConfigDigest).toBeTruthy();
  });
});
