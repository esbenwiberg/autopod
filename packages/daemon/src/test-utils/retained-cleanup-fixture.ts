import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { createPodRepository } from '../pods/pod-repository.js';
import type { AllocationScope } from '../pods/retained-allocation-inventory.js';
import { checkpointResourceIdentity } from '../pods/retained-checkpoint-repository.js';
import { gitWorktreeIdentity } from '../worktrees/allocation-identity.js';
import { prepareRetainedCheckpointWorkspace } from '../worktrees/retained-checkpoint-workspace.js';
import { insertTestProfile } from './mock-helpers.js';

const exec = promisify(execFile);
export const fixtureGit = async (cwd: string, ...args: string[]) =>
  (
    await exec(
      'git',
      [
        '-c',
        'user.name=Retained cleanup test',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();

export async function retainedCleanupFixture(input: {
  db: Database.Database;
  root: string;
  podId: string;
  engine: string;
  spawn(scope: AllocationScope, identity: string, source: string, common: string): Promise<string>;
}) {
  const { db, root, podId, engine } = input;
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: podId,
    profileName: 'test-profile',
    task: 'fixture',
    status: 'queued',
    branch: podId,
    model: 'fixture',
    runtime: 'codex',
    executionTarget: 'local',
    userId: 'fixture-human',
    maxValidationAttempts: 1,
    skipValidation: false,
    outputMode: 'pr',
  });
  const taskId = repo.taskExecutions!.snapshot(podId).taskId;
  const scope = (id?: string) => repo.retainedAllocations!.scope(podId, id)!;
  const seed = path.join(root, 'seed');
  const bare = path.join(root, 'shared.git');
  const original = path.join(root, 'original');
  const unrelated = path.join(root, 'other-worktree');
  await mkdir(seed);
  await fixtureGit(seed, 'init', '-b', 'main');
  await writeFile(path.join(seed, 'README'), 'preserve unrelated source and common store');
  await fixtureGit(seed, 'add', 'README');
  await fixtureGit(seed, 'commit', '-m', 'seed fixture');
  await fixtureGit(root, 'clone', '--bare', '--no-local', seed, bare);
  const a = scope().begin('original-worktree', original);
  await fixtureGit(bare, 'worktree', 'add', '-b', podId, original, 'main');
  a.owned(await gitWorktreeIdentity(original, 'shared-cache', bare));
  await fixtureGit(bare, 'worktree', 'add', '--detach', unrelated, 'main');
  const originalId = await input.spawn(scope(), podId, original, bare);
  repo.update(podId, { worktreePath: original, containerId: originalId });
  const recoveryId = 'fixture-continuation';
  db.prepare(`INSERT INTO retained_checkpoint_recoveries
    (id,pod_id,task_id,generation,container_id,resource_key,worktree_path,request_hash,actor,reason,binding,original_evidence,created_at)
    VALUES (?,?,?,1,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).run(
    recoveryId,
    podId,
    taskId,
    originalId,
    JSON.stringify(['docker', engine, originalId]),
    original,
    'fixture-hash',
    JSON.stringify({ type: 'human', userId: 'fixture-human' }),
    'Fixture continues an ordinary task',
    JSON.stringify({ continuation: {} }),
    '{}',
  );
  const preparedRoot = path.join(root, 'prepared');
  const prepared = await prepareRetainedCheckpointWorkspace({
    root: preparedRoot,
    source: original,
    branch: podId,
    head: await fixtureGit(original, 'rev-parse', 'HEAD'),
    repository: 'https://example.test/retained.git',
    generation: 1,
    cycle: 1,
    assertCurrent() {},
    allocation: scope(recoveryId),
  });
  const event = db.prepare(`INSERT INTO retained_checkpoint_recovery_events
    (recovery_id,kind,evidence,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)`);
  event.run(recoveryId, 'prepared', JSON.stringify(prepared));
  const replacement = await repo.retainedCheckpoints!.owned(recoveryId, async () => {
    repo.incrementLifecycleGeneration(podId);
    repo.update(podId, { worktreePath: prepared.worktree, containerId: null });
    event.run(recoveryId, 'activated', JSON.stringify({ generation: 2 }));
    const id = await input.spawn(
      scope(recoveryId),
      checkpointResourceIdentity(podId, recoveryId, 2),
      prepared.worktree,
      prepared.bare,
    );
    repo.update(podId, { containerId: id });
    event.run(recoveryId, 'checked', '{}'); // Fixture models completed checks; execution recovery tests own actual check execution.
    return id;
  });
  db.prepare("UPDATE pods SET status='failed', input_tokens=123 WHERE id=?").run(podId);
  return {
    repo,
    podId,
    taskId,
    recoveryId,
    originalId,
    original,
    replacement,
    prepared,
    preparedRoot,
    bare,
    unrelated,
  };
}
