import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  JwtPayload,
  OperatorActor,
  SavedWorkDraftConfirm,
  SavedWorkDraftOperation,
} from '@autopod/shared';
import { AuthError } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authPlugin } from '../api/plugins/auth.js';
import { savedWorkDraftRoutes } from '../api/routes/saved-work-draft-pr.js';
import type { SavedDraftObservation, SavedDraftProvider } from '../interfaces/pr-manager.js';
import {
  createFailingValidationResult,
  createMockContainerManager,
  createMockWorktreeManager,
  createTestContext,
} from '../test-utils/mock-helpers.js';
import { INTEGRATION_TEST_TIMEOUT_MS } from '../test-utils/test-budgets.js';
import { checkpointSandboxWorkspace } from '../worktrees/sandbox-workspace-checkpoint.js';
import { checkpointSavedSource } from '../worktrees/saved-work-source.js';
import { createControlOperationRegistry } from './control-operation-registry.js';
import { createSavedWorkDraftPr } from './saved-work-draft-pr.js';

// Each case drives independent real Git object stores and migrated SQLite ledgers.
vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS });
const exec = promisify(execFile);
const actor: OperatorActor = { type: 'human', userId: 'human-reviewer' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
async function fixture(sandbox = false) {
  const ctx = createTestContext();
  const root = await mkdtemp(path.join(os.tmpdir(), 'saved-work-draft-'));
  cleanup.push(async () => {
    ctx.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'original');
  await mkdir(source);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec('git', args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })
    ).stdout.trim();
  await git(source, 'init', '-b', 'feature/saved');
  await git(source, 'config', 'user.name', 'Fixture');
  await git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(source, 'file.txt'), 'saved bytes\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'saved work');
  await git(source, 'remote', 'add', 'origin', 'https://github.com/org/repo');
  const id = 'saved-work-fixture';
  ctx.podRepo.insert({
    id,
    profileName: 'test-profile',
    task: 'Share failed saved work',
    status: 'failed',
    model: 'opus',
    runtime: 'claude',
    executionTarget: sandbox ? 'sandbox' : 'local',
    branch: 'feature/saved',
    userId: 'human-reviewer',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  const settings = ctx.profileStore.get('test-profile')!;
  ctx.podRepo.update(id, {
    worktreePath: source,
    profileSnapshot: settings,
    baseBranch: 'main',
    failureReason: 'feature branch diverged from checkpoint source',
    worktreeCompromised: sandbox,
  });
  const worktrees = createMockWorktreeManager();
  Object.assign(worktrees, { supportsCreateOnlyPublication: true });
  let remote: string | null = null;
  let observed: SavedDraftObservation | null = null;
  worktrees.pushBranch = vi.fn(async (cwd, branch, options) => {
    await options?.beforePrepared?.();
    if (remote) throw new Error('occupied');
    const head = await git(cwd, 'rev-parse', 'HEAD');
    const tree = await git(cwd, 'rev-parse', 'HEAD^{tree}');
    const evidence = {
      branch,
      repository: 'https://github.com/org/repo',
      commitSha: head,
      treeSha: tree,
      worktreeClean: true as const,
      remoteRef: `refs/heads/${branch}`,
    };
    options?.onPrepared?.(evidence);
    remote = head;
    return { ...evidence, observedRemoteCommitSha: head, observedAt: new Date().toISOString() };
  });
  worktrees.observeSourceBranch = vi.fn(async () => remote ?? '');
  const provider: SavedDraftProvider = {
    find: vi.fn(async () => observed),
    create: vi.fn(async (t, body, onPrepared) => {
      await onPrepared();
      observed = {
        url: 'https://github.com/org/repo/pull/91',
        repository: t.repository,
        branch: t.branch,
        baseBranch: t.baseBranch,
        head: t.head,
        draft: true,
        open: true,
        merged: false,
        body,
      };
    }),
  };
  let idle = true;
  let goal = false;
  let clock = Date.now();
  const scanPublication = vi.fn(async () => {});
  const deps = {
    scanPublication,
    podRepo: ctx.podRepo,
    executionForPod: () => settings,
    worktreeManager: worktrees,
    prManagerFactory: () => ({
      savedDraft: provider,
      createPr: vi.fn(),
      mergePr: vi.fn(),
      getPrStatus: vi.fn(),
    }),
    root: path.join(root, 'drafts'),
    isIdle: () => idle,
    isGoal: () => goal,
    now: () => clock,
  };
  const controller = () => createSavedWorkDraftPr(deps);
  const prepare = async (sourceId?: string) => {
    const c = controller();
    const preview = await c.inspect(id, actor);
    return c.prepare(
      id,
      {
        requestId: 'stable-request',
        expectedBinding: preview.binding,
        sourceId: sourceId ?? preview.sources[0]!.id,
      },
      actor,
    );
  };
  const confirm = (op: SavedWorkDraftOperation): SavedWorkDraftConfirm => ({
    requestId: op.requestId,
    expectedBinding: op.confirmationBinding,
    draftOnly: true,
  });
  return {
    ...ctx,
    root,
    source,
    git,
    id,
    settings,
    worktrees,
    provider,
    scanPublication,
    controller,
    prepare,
    confirm,
    setIdle: (v: boolean) => {
      idle = v;
    },
    setGoal: () => {
      goal = true;
    },
    advance: () => {
      clock += 16 * 60_000;
    },
    setRemote: (v: string | null) => {
      remote = v;
    },
    setObserved: (v: SavedDraftObservation | null) => {
      observed = v;
    },
  };
}

describe('saved-work exact human draft publication', () => {
  it.each([
    false,
    true,
  ])('publishes failed task with failed checks=%s without lifecycle authority', async (failedChecks) => {
    const f = await fixture();
    if (failedChecks)
      f.podRepo.update(f.id, {
        lastValidationResult: createFailingValidationResult(f.id, 3),
        validationAttempts: 3,
      });
    await writeFile(path.join(f.source, 'file.txt'), 'unstaged original\n');
    await writeFile(path.join(f.source, 'unsaved.txt'), 'excluded\n');
    const before = f.podRepo.getOrThrow(f.id);
    const index = await readFile(path.join(f.source, '.git/index'));
    const refs = await f.git(f.source, 'show-ref');
    const preview = await f.controller().inspect(f.id, actor);
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    expect(f.provider.create).not.toHaveBeenCalled();
    expect(preview.checks).toContain(failedChecks ? 'Historical checks' : 'NOT RUN');
    const op = await f.prepare();
    expect(op.state).toBe('prepared');
    expect(op.source.exclusions).toContain('Dirty');
    expect(() => f.podRepo.update(f.id, { status: 'running' })).toThrow(/draft publication/);
    expect(() => f.podRepo.delete(f.id)).toThrow(/draft publication/);
    const result = await f.controller().confirm(f.id, f.confirm(op), actor);
    expect(result.state).toBe('published');
    expect(result.receipt?.head).toBe(op.source.commit);
    expect(f.worktrees.pushBranch).toHaveBeenCalledWith(
      expect.any(String),
      op.branch,
      expect.objectContaining({ createOnly: true }),
    );
    expect(
      await f.git(path.join(f.root, 'drafts', op.id, 'worktree'), 'rev-parse', 'HEAD^{tree}'),
    ).toBe(op.source.tree);
    expect(f.podRepo.getOrThrow(f.id)).toEqual(before);
    expect(await f.git(f.source, 'show-ref')).toBe(refs);
    expect(await readFile(path.join(f.source, '.git/index'))).toEqual(index);
    expect(await readFile(path.join(f.source, 'file.txt'), 'utf8')).toBe('unstaged original\n');
    expect(await f.controller().confirm(f.id, f.confirm(op), actor)).toEqual(result);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    const after = await f.controller().inspect(f.id, actor);
    await expect(
      f.controller().prepare(
        f.id,
        {
          requestId: 'different-request',
          expectedBinding: after.binding,
          sourceId: op.source.id,
        },
        actor,
      ),
    ).rejects.toThrow(/already has operation/);
  });

  it('uses real imported sandbox bytes after promotion-only divergence and preserves original', async () => {
    const f = await fixture(true);
    const guest = path.join(f.root, 'sandbox');
    await f.git(f.root, 'clone', '--no-local', f.source, guest);
    await writeFile(path.join(guest, 'file.txt'), 'captured sandbox bytes\n');
    await writeFile(path.join(f.source, 'host-only.txt'), 'independent host commit\n');
    await f.git(f.source, 'add', '.');
    await f.git(f.source, 'commit', '-m', 'diverge host');
    const cm = createMockContainerManager();
    cm.execInContainer = vi.fn(async (_id, command) => {
      const [program, ...argv] = command;
      const r = await exec(
        program!,
        argv.map((s) => s.replace('cd /workspace', `cd ${guest}`)),
      );
      return { ...r, exitCode: 0 };
    });
    cm.readFile = vi.fn(async (_id, p) => readFile(p, 'utf8'));
    cm.readFileBinary = vi.fn(async (_id, p) => readFile(p));
    const result = await checkpointSandboxWorkspace({
      containerManager: cm,
      containerId: 'original-sandbox',
      podId: f.id,
      worktreePath: f.source,
      sequence: 1,
      assertCurrent: () => {},
    });
    expect(result.error?.code).toBe('LINEAGE_CONFLICT');
    expect(result.hostImported).toBe(true);
    await f.podRepo.savedWorkspaceCheckpoints!.save({
      podId: f.id,
      sequence: 1,
      fingerprint: { head: result.sourceHead, tree: result.sourceTree, dirty: true },
      result,
      verifiedAt: null,
      attempts: 1,
      error: result.error,
    });
    const original = await f.git(f.source, 'show-ref');
    const op = await f.prepare('checkpoint-1');
    expect(op.source.freshness).toBe('latest-saved');
    expect(op.source.commit).toBe(result.snapshotCommit);
    expect(await readFile(path.join(f.root, 'drafts', op.id, 'worktree/file.txt'), 'utf8')).toBe(
      'captured sandbox bytes\n',
    );
    await f.controller().confirm(f.id, f.confirm(op), actor);
    expect(await f.git(f.source, 'show-ref')).toBe(original);
    expect(f.podRepo.getOrThrow(f.id).worktreeCompromised).toBe(true);
    expect(cm.execInContainer).toHaveBeenCalledTimes(1); // only explicit fixture capture, no action wake/export
  });

  it('requires explicit older-source selection and rejects partial/stale checkpoint proof', async () => {
    const f = await fixture(true);
    const head = await f.git(f.source, 'rev-parse', 'HEAD');
    const tree = await f.git(f.source, 'rev-parse', 'HEAD^{tree}');
    const snapshot = (
      await exec('git', ['commit-tree', tree, '-p', head, '-m', 'snapshot'], { cwd: f.source })
    ).stdout.trim();
    await f.git(f.source, 'update-ref', `refs/autopod-quarantine/${f.id}/1`, snapshot);
    const result = {
      sequence: 1,
      sourceHead: head,
      sourceTree: tree,
      snapshotCommit: snapshot,
      snapshotTree: tree,
      transferVerified: true,
      bundleVerified: true,
      hostImported: true,
      lineageVerified: true,
      promoted: false,
      materialized: false,
      quarantineRef: `refs/autopod-quarantine/${f.id}/1`,
    };
    const record = {
      podId: f.id,
      sequence: 1,
      fingerprint: { head, tree, dirty: true },
      result,
      verifiedAt: null,
      attempts: 1,
      error: undefined,
    };
    await f.podRepo.savedWorkspaceCheckpoints!.save(record);
    f.db
      .prepare('UPDATE workspace_checkpoints SET created_at=? WHERE pod_id=? AND sequence=1')
      .run('2026-01-01T00:00:00Z', f.id);
    await f.podRepo.savedWorkspaceCheckpoints!.save(record);
    expect((await f.podRepo.savedWorkspaceCheckpoints!.latest(f.id))?.capturedAt).toBe(
      '2026-01-01T00:00:00Z',
    );
    for (const invalid of [
      { transferVerified: false },
      { bundleVerified: false },
      { hostImported: false },
      { lineageVerified: false },
      { snapshotCommit: head },
      { snapshotTree: head },
      { sourceHead: snapshot },
      { sourceTree: head },
      { quarantineRef: 'refs/autopod-quarantine/other-pod/1' },
    ]) {
      await expect(
        checkpointSavedSource(
          f.id,
          f.source,
          f.settings.repoUrl,
          {
            ...record,
            result: { ...result, ...invalid },
          },
          1,
        ),
      ).rejects.toThrow();
    }
    await f.podRepo.savedWorkspaceCheckpoints!.save({
      ...record,
      sequence: 2,
      result: { ...result, sequence: 2, hostImported: false },
    });
    const preview = await f.controller().inspect(f.id, actor);
    expect(preview.sources[0]).toMatchObject({ id: 'checkpoint-1', freshness: 'older-saved' });
    expect(preview.blockers.join()).toContain('Snapshot 2 unavailable');
    await expect(
      f
        .controller()
        .prepare(
          f.id,
          { requestId: 'x', expectedBinding: preview.binding, sourceId: 'checkpoint-2' },
          actor,
        ),
    ).rejects.toThrow(/selection/);
    const older = await f.prepare('checkpoint-1');
    expect(older.source.freshness).toBe('older-saved');
    expect(
      await f.git(path.join(f.root, 'drafts', older.id, 'worktree'), 'rev-parse', 'HEAD'),
    ).toBe(snapshot);
    await f.git(f.source, 'update-ref', result.quarantineRef, head);
    await expect(
      f
        .controller()
        .prepare(
          f.id,
          { requestId: 'x', expectedBinding: preview.binding, sourceId: 'checkpoint-1' },
          actor,
        ),
    ).rejects.toThrow(/Preview changed/);
  });

  it('denies unauthorized outputs, actors, native goals, active ownership and stale confirmation', async () => {
    const f = await fixture();
    await expect(f.controller().inspect(f.id, { type: 'system' } as OperatorActor)).rejects.toThrow(
      /human/,
    );
    for (const output of ['artifact', 'none', 'branch'] as const) {
      f.podRepo.update(f.id, { options: { ...f.podRepo.getOrThrow(f.id).options, output } });
      expect((await f.controller().inspect(f.id, actor)).sources).toEqual([]);
    }
    f.podRepo.update(f.id, { options: { ...f.podRepo.getOrThrow(f.id).options, output: 'pr' } });
    f.setIdle(false);
    expect((await f.controller().inspect(f.id, actor)).blockers.join()).toContain('active');
    f.setIdle(true);
    const op = await f.prepare();
    await expect(
      f.controller().confirm(f.id, f.confirm(op), { type: 'human', userId: 'other' }),
    ).rejects.toThrow(/confirmation/);
    f.advance();
    const expired = await f.controller().confirm(f.id, f.confirm(op), actor);
    expect(expired.state).toBe('cancelled');
    expect(expired.message).toContain('expired');
    expect(() => f.podRepo.savedWorkDrafts!.assertAvailable(f.id)).not.toThrow();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    f.setGoal();
    expect((await f.controller().inspect(f.id, actor)).sources).toEqual([]);
  });

  it('does not replay uncertain push/create after restart, negative lookup or concurrent confirms', async () => {
    const f = await fixture();
    const op = await f.prepare();
    f.worktrees.pushBranch = vi.fn(async (_cwd, branch, options) => {
      options?.onPrepared?.({
        branch,
        repository: op.repository,
        commitSha: op.source.commit,
        treeSha: op.source.tree,
        worktreeClean: true,
        remoteRef: `refs/heads/${branch}`,
      });
      throw new Error('lost push reply');
    });
    const outcomes = await Promise.allSettled([
      f.controller().confirm(f.id, f.confirm(op), actor),
      f.controller().confirm(f.id, f.confirm(op), actor),
    ]);
    expect(outcomes.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(f.podRepo.savedWorkDrafts!.get(f.id, op.requestId)?.state).toBe('push-uncertain');
    expect(() =>
      f
        .controller()
        .cancel(f.id, { requestId: op.requestId, expectedBinding: op.confirmationBinding }, actor),
    ).toThrow(/external effect/);
    await f.controller().observe(f.id, op.requestId, actor);
    expect(f.provider.create).not.toHaveBeenCalled();
    f.setRemote(op.source.commit);
    await f.controller().observe(f.id, op.requestId, actor);
    f.provider.create = vi.fn(async (_t, _body, admitted) => {
      await admitted();
      throw new Error('lost create reply');
    });
    await f.controller().confirm(f.id, f.confirm(op), actor);
    await f.controller().confirm(f.id, f.confirm(op), actor);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.podRepo.savedWorkDrafts!.get(f.id, op.requestId)?.state).toBe('create-uncertain');
    expect(() =>
      f
        .controller()
        .cancelPreparation(
          f.id,
          { requestId: op.requestId, expectedBinding: op.previewBinding, sourceId: op.source.id },
          actor,
        ),
    ).toThrow(/external effect/);
    expect(() =>
      f
        .controller()
        .cancel(f.id, { requestId: op.requestId, expectedBinding: op.confirmationBinding }, actor),
    ).toThrow(/external effect/);
  });

  it('rejects occupied branch without create admission or any PR create', async () => {
    const f = await fixture();
    const op = await f.prepare();
    f.setRemote(op.source.commit);
    await expect(f.controller().confirm(f.id, f.confirm(op), actor)).rejects.toThrow('occupied');
    expect(f.podRepo.savedWorkDrafts!.get(f.id, op.requestId)?.state).toBe('prepared');
    expect(f.provider.create).not.toHaveBeenCalled();
  });

  it('releases only its own fence after pre-effect failure or exact human cancellation', async () => {
    const f = await fixture();
    const original = f.podRepo.getOrThrow(f.id);
    await writeFile(path.join(f.root, 'drafts'), 'block independent storage preparation');
    const failed = await f.prepare();
    expect(failed.state).toBe('cancelled');
    expect(failed.message).toContain('Preparation failed');
    expect(f.podRepo.getOrThrow(f.id)).toEqual(original);
    expect(() => f.podRepo.savedWorkDrafts!.assertAvailable(f.id)).not.toThrow();
    await rm(path.join(f.root, 'drafts'));
    const preview = await f.controller().inspect(f.id, actor);
    const op = await f.controller().prepare(
      f.id,
      {
        requestId: 'fresh-request',
        expectedBinding: preview.binding,
        sourceId: preview.sources[0]!.id,
      },
      actor,
    );
    const cancel = { requestId: op.requestId, expectedBinding: op.confirmationBinding };
    expect(() => f.controller().cancel(f.id, cancel, { type: 'human', userId: 'other' })).toThrow(
      /actor-bound/,
    );
    expect(f.controller().cancel(f.id, cancel, actor).state).toBe('cancelled');
    expect(f.controller().cancel(f.id, cancel, actor).state).toBe('cancelled');
    expect(() => f.podRepo.savedWorkDrafts!.assertAvailable(f.id)).not.toThrow();
    expect(await readFile(path.join(f.root, 'drafts', op.id, 'worktree/file.txt'), 'utf8')).toBe(
      'saved bytes\n',
    );
    expect(f.podRepo.getOrThrow(f.id)).toEqual(original);
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    expect(f.provider.create).not.toHaveBeenCalled();
  });

  it('cannot push if cancellation wins final admission', async () => {
    const f = await fixture();
    const op = await f.prepare();
    f.worktrees.pushBranch = vi.fn(async (_cwd, _branch, options) => {
      f.controller().cancel(
        f.id,
        { requestId: op.requestId, expectedBinding: op.confirmationBinding },
        actor,
      );
      await options?.beforePrepared?.();
      throw new Error('Cancellation must prevent admission');
    });
    expect((await f.controller().confirm(f.id, f.confirm(op), actor)).state).toBe('cancelled');
    expect(f.provider.create).not.toHaveBeenCalled();
  });

  it('durably revokes an unrecorded preparation and denies its delayed arrival', async () => {
    const f = await fixture();
    const preview = await f.controller().inspect(f.id, actor);
    const request = {
      requestId: 'lost-before-admission',
      expectedBinding: preview.binding,
      sourceId: preview.sources[0]!.id,
    };
    const receipt = f.controller().cancelPreparation(f.id, request, actor);
    expect(receipt.state).toBe('cancelled-before-publication');
    expect(f.controller().cancelPreparation(f.id, request, actor)).toEqual(receipt);
    await expect(f.controller().prepare(f.id, request, actor)).rejects.toThrow(/durably cancelled/);
    expect(f.podRepo.savedWorkDrafts!.get(f.id, request.requestId)).toBeNull();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    const replacement = await f
      .controller()
      .prepare(f.id, { ...request, requestId: 'fresh-selection' }, actor);
    expect(replacement.state).toBe('prepared');
    expect(() =>
      f.controller().cancelPreparation(f.id, request, { type: 'human', userId: 'other' }),
    ).toThrow(/different exact request/);
  });

  it('fences preparation already inspecting when pending revocation commits', async () => {
    const f = await fixture();
    const c = f.controller();
    const preview = await c.inspect(f.id, actor);
    const request = {
      requestId: 'delayed-inspection',
      expectedBinding: preview.binding,
      sourceId: preview.sources[0]!.id,
    };
    let release = () => {};
    let entered = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrival = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const records = f.podRepo.savedWorkspaceCheckpoints!;
    vi.spyOn(records, 'list').mockImplementation(async () => {
      entered();
      await barrier;
      return [];
    });
    const preparation = c.prepare(f.id, request, actor);
    await arrival;
    expect(c.cancelPreparation(f.id, request, actor).state).toBe('cancelled-before-publication');
    release();
    await expect(preparation).rejects.toThrow(/durably cancelled/);
    expect(f.podRepo.savedWorkDrafts!.get(f.id, request.requestId)).toBeNull();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
  });

  it('keeps publication security policy on exact independent bytes without running validation', async () => {
    const f = await fixture();
    await f.controller().inspect(f.id, actor);
    const op = await f.prepare();
    expect(f.scanPublication).not.toHaveBeenCalled();
    f.scanPublication.mockRejectedValue(new Error('Security policy blocked selected source'));
    await expect(f.controller().confirm(f.id, f.confirm(op), actor)).rejects.toThrow(
      /Security policy/,
    );
    expect(f.scanPublication).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.id }),
      path.join(f.root, 'drafts', op.id, 'worktree'),
    );
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    expect(f.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.podRepo.getOrThrow(f.id).lastValidationResult).toBeNull();
  });

  it('distinguishes permanent checked history from active rewrite custody', async () => {
    const f = await fixture();
    f.db
      .prepare('INSERT INTO approval_source_rewrites VALUES (?,?,?,?,?)')
      .run('rewrite', f.id, 0, '{}', 'now');
    expect((await f.controller().inspect(f.id, actor)).blockers.join()).toContain('Active source');
    f.db
      .prepare(
        'INSERT INTO approval_source_rewrite_events(rewrite_id,kind,evidence,created_at) VALUES (?,?,?,?)',
      )
      .run('rewrite', 'checked', '{}', 'now');
    expect((await f.controller().inspect(f.id, actor)).sources.length).toBeGreaterThan(0);
  });

  it('rejects stale exact source or active custody even after preparation', async () => {
    const f = await fixture();
    const op = await f.prepare();
    await f.git(f.source, 'commit', '--allow-empty', '-m', 'external source advance');
    await expect(f.controller().confirm(f.id, f.confirm(op), actor)).rejects.toThrow(/stale/);
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    f.db
      .prepare('INSERT INTO approval_source_rewrites VALUES (?,?,?,?,?)')
      .run('rewrite', f.id, 0, '{}', 'now');
    await expect(f.controller().confirm(f.id, f.confirm(op), actor)).rejects.toThrow(
      /Active source/,
    );
  });

  it('reconciles only an exact positive draft after an uncertain create', async () => {
    const f = await fixture();
    const op = await f.prepare();
    f.provider.create = vi.fn(async (_target, _body, admission) => {
      await admission();
      throw new Error('lost create reply');
    });
    await f.controller().confirm(f.id, f.confirm(op), actor);
    const observation: SavedDraftObservation = {
      url: 'https://github.com/org/repo/pull/91',
      repository: op.repository,
      branch: op.branch,
      baseBranch: op.baseBranch,
      head: op.source.commit,
      draft: false,
      open: true,
      merged: false,
      body: op.body,
    };
    f.setObserved(observation);
    await expect(f.controller().observe(f.id, op.requestId, actor)).rejects.toThrow(/open draft/);
    expect(f.podRepo.savedWorkDrafts!.get(f.id, op.requestId)?.receipt).toBeNull();
    f.setObserved({ ...observation, draft: true });
    expect((await f.controller().observe(f.id, op.requestId, actor)).receipt?.draft).toBe(true);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
  });

  it('authenticates routes, rejects forged DTO authority and maps exact actor/selection', async () => {
    const f = await fixture();
    const c = f.controller();
    const app = Fastify();
    cleanup.push(() => app.close());
    authPlugin(app, {
      validateToken: async (token) => {
        if (token !== 'human-token')
          throw new AuthError('Worker/managed token is not human authority');
        return { oid: 'human-reviewer', roles: ['operator'] } as JwtPayload;
      },
    });
    const headers = { authorization: 'Bearer human-token' };
    app.setErrorHandler((error, _req, reply) =>
      reply
        .code('statusCode' in error ? Number(error.statusCode) : 400)
        .send({ error: error.message }),
    );
    const registry = createControlOperationRegistry((id) =>
      f.podRepo.savedWorkDrafts!.assertAvailable(id),
    );
    savedWorkDraftRoutes(
      app,
      registry.wrap({
        inspectSavedWorkDraft: c.inspect,
        prepareSavedWorkDraft: c.prepare,
        confirmSavedWorkDraft: c.confirm,
        observeSavedWorkDraft: c.observe,
        cancelSavedWorkDraft: async (id, input, human) => c.cancel(id, input, human),
        cancelSavedWorkDraftPreparation: async (id, input, human) =>
          c.cancelPreparation(id, input, human),
      }),
    );
    expect((await app.inject(`/pods/${f.id}/saved-work-draft`)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: `/pods/${f.id}/saved-work-draft`,
          headers: { authorization: 'Bearer worker-token' },
        })
      ).statusCode,
    ).toBe(401);
    const preview = (await app.inject({ url: `/pods/${f.id}/saved-work-draft`, headers })).json();
    const payload = {
      requestId: 'route-request',
      expectedBinding: preview.binding,
      sourceId: preview.sources[0].id,
    };
    const revoked = { ...payload, requestId: 'route-revoked' };
    const revocation = await app.inject({
      method: 'POST',
      headers,
      url: `/pods/${f.id}/saved-work-draft/cancel-preparation`,
      payload: revoked,
    });
    expect(revocation.json()).toMatchObject({
      ...revoked,
      actorId: 'human-reviewer',
      state: 'cancelled-before-publication',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          headers,
          url: `/pods/${f.id}/saved-work-draft/prepare`,
          payload: revoked,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          headers,
          url: `/pods/${f.id}/saved-work-draft/prepare`,
          payload: { ...payload, actor: { type: 'human', userId: 'forged' } },
        })
      ).statusCode,
    ).toBe(400);
    let prepared = await app.inject({
      headers,
      method: 'POST',
      url: `/pods/${f.id}/saved-work-draft/prepare`,
      payload,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().actorId).toBe('human-reviewer');
    const cancelled = await app.inject({
      method: 'POST',
      headers,
      url: `/pods/${f.id}/saved-work-draft/cancel`,
      payload: {
        requestId: payload.requestId,
        expectedBinding: prepared.json().confirmationBinding,
      },
    });
    expect(cancelled.json().state).toBe('cancelled');
    payload.requestId = 'route-request-new';
    prepared = await app.inject({
      method: 'POST',
      headers,
      url: `/pods/${f.id}/saved-work-draft/prepare`,
      payload,
    });
    expect(prepared.statusCode).toBe(200);
    const published = await app.inject({
      headers,
      method: 'POST',
      url: `/pods/${f.id}/saved-work-draft/confirm`,
      payload: {
        requestId: payload.requestId,
        expectedBinding: prepared.json().confirmationBinding,
        draftOnly: true,
      },
    });
    expect(published.json().receipt).toMatchObject({
      draft: true,
      head: preview.sources[0].commit,
    });
    expect(
      (
        await app.inject({ url: `/pods/${f.id}/saved-work-draft/${payload.requestId}`, headers })
      ).json().id,
    ).toBe(prepared.json().id);
  });
});
