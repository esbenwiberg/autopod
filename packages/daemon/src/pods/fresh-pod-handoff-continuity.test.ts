import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AUTOPOD_INSTRUCTIONS_PATH } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { RECOVERY_CONTINUATION_INSTRUCTION } from '../configuration/recovery-fork-launch.js';
import { openTestDiskDatabase } from '../test-utils/disk-database.js';
import { codingTransport, fixture, git } from '../test-utils/fresh-handoff-helpers.js';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import { INTEGRATION_TEST_TIMEOUT_MS } from '../test-utils/test-budgets.js';
import { recoveryBytesHash } from '../worktrees/recovery-fork-source.js';
import { createEventRepository } from './event-repository.js';
import { createPodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';
import { createRecoveryForkRepository } from './recovery-fork-repository.js';

// Two production admissions and real independent Git imports per chain.
vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS });

describe('fresh-pod handoff continuity with real Git and SQLite', () => {
  it('imports B’s latest checkpoint, A’s inherited source and B’s saved edit before C codes without an operator note', async () => {
    const f = await fixture(
      false,
      'Preserve parser compatibility. Do not publish without approval.',
    );
    const events = f.ctx.deps.eventRepo!;
    const log = (podId: string, message: string) =>
      events.insert({
        type: 'pod.agent_activity',
        podId,
        timestamp: new Date().toISOString(),
        event: { type: 'status', message, timestamp: new Date().toISOString() },
      });
    log(f.podId, 'Attempt A: parser saved; original checks failed.');
    const a = f.pod();
    await writeFile(
      path.join(a.worktreePath!, 'inherited-note.txt'),
      'A saved supplemental edit\n',
    );
    const initial = await f.manager.inspectRecoveryFork(a.id);
    f.input.files = initial.source!.files.map(({ path, version }) => ({ path, version }));
    codingTransport(f);
    f.ctx.validationEngine.validate = vi.fn(async (config) => ({
      ...createFailingValidationResult(config.podId, config.attempt),
      infrastructureFailure: {
        phase: 'setup' as const,
        code: 'COMMAND_NOT_FOUND',
        statusCode: 409,
        message: 'Synthetic test launcher unavailable',
        retryable: false,
      },
    }));
    let bHead = '';
    f.ctx.runtime.spawn = vi.fn(async function* () {
      const prepared = f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.prepared!;
      expect(await readFile(path.join(prepared.worktree, 'source.ts'), 'utf8')).toContain(
        'preserved',
      );
      await writeFile(
        path.join(prepared.worktree, 'regression.test.ts'),
        'export const blankRowsCovered = true;\n',
      );
      await git(prepared.worktree, 'add', 'regression.test.ts');
      await git(
        prepared.worktree,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Save B regression test',
      );
      bHead = await git(prepared.worktree, 'rev-parse', 'HEAD');
      await writeFile(
        path.join(prepared.worktree, 'inherited-note.txt'),
        'B revised inherited supplemental edit\n',
      );
      const b = f.ctx.podRepo.recoveryForks!.parent(f.podId)!.facts.admitted!.childPodId;
      log(b, 'Attempt B: regression and revised supplement saved; checks did not complete.');
      yield {
        type: 'complete' as const,
        timestamp: new Date().toISOString(),
        result: 'Regression saved; run the original checks next.',
        totalInputTokens: 20,
        totalOutputTokens: 10,
        costUsd: 0.001,
      };
    });
    const firstRequest = await f.request();
    const first = await f.manager.createRecoveryFork(f.podId, firstRequest, f.actor);
    await f.manager.processPod(first.childPodId!);
    const b = f.ctx.podRepo.getOrThrow(first.childPodId!);
    expect(['failed', 'review_required']).toContain(b.status);
    // Positive daemon completion/run evidence is required; no unknown-exit bypass.
    expect(f.ctx.podRepo.taskExecutions!.snapshot(b.id).taskId).toBe(
      f.ctx.podRepo.taskExecutions!.snapshot(a.id).taskId,
    );
    await writeFile(
      path.join(b.worktreePath!, 'saved-note.txt'),
      'Safely captured B supplemental edit\n',
    );
    f.cm.getStatus = vi.fn(async (id) => (id === '3'.repeat(64) ? 'running' : 'stopped'));
    const view = await f.manager.inspectRecoveryFork(b.id);
    expect(view.budget?.status, JSON.stringify(f.ctx.podRepo.taskExecutions!.snapshot(b.id))).toBe(
      'below_recorded_limit',
    );
    expect(
      view.blockers,
      JSON.stringify({
        reason: b.failureReason,
        finalization: b.finalization,
        runs: f.ctx.db.prepare('SELECT * FROM task_agent_runs WHERE pod_id=?').all(b.id),
      }),
    ).toEqual([]);
    expect(view.source?.head).toBe(bHead);
    const priorPacket = f.ctx.podRepo.recoveryForks!.parent(a.id)!.facts.prepared!.packet;
    const priorBytes = await readFile(priorPacket, 'utf8');
    await chmod(priorPacket, 0o644);
    await writeFile(priorPacket, priorBytes + 'tampered');
    await expect(f.manager.inspectRecoveryFork(b.id)).rejects.toThrow('tampered');
    await writeFile(priorPacket, priorBytes);
    await chmod(priorPacket, 0o444);
    const input = {
      ...f.input,
      instructions: '',
      expectedGeneration: b.lifecycleGeneration,
      sourceHead: bHead,
      files: view.source!.files.map(({ path, version }) => ({ path, version })),
    };
    const preview = await f.manager.previewRecoveryFork(b.id, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.workerBriefHash).toBe(recoveryBytesHash(preview.workerBrief!));
    expect(JSON.parse(preview.workerBrief!).importedSupplementalFiles[0].sha256).toBe(
      recoveryBytesHash('B revised inherited supplemental edit\n'),
    );
    const request = { ...input, id: 'start-c', expectedBinding: preview.expectedBinding! };
    codingTransport(f, 'qualified', b.id, '3'.repeat(64));
    let workerInspected = false;
    f.ctx.runtime.spawn = vi.fn(async function* () {
      const record = f.ctx.podRepo.recoveryForks!.parent(b.id)!;
      const p = record.facts.prepared!;
      expect(record.facts.qualified?.evidence.outcome).toBe('qualified');
      const current = f.ctx.podRepo.getOrThrow(record.facts.admitted!.childPodId);
      expect(current).toMatchObject({
        lastValidationResult: null,
        validationWaiver: null,
        autoApprove: false,
        tokenBudget: a.tokenBudget,
        prFixAttempts: b.prFixAttempts,
        maxPrFixAttempts: b.maxPrFixAttempts,
      });
      expect(
        vi
          .mocked(f.cm.writeFile)
          .mock.calls.some(
            ([id, file, bytes]) =>
              id === '3'.repeat(64) &&
              file === AUTOPOD_INSTRUCTIONS_PATH &&
              bytes.includes(RECOVERY_CONTINUATION_INSTRUCTION),
          ),
      ).toBe(true);
      expect(await git(p.worktree, 'rev-parse', 'HEAD')).toBe(bHead);
      expect(await readFile(path.join(p.worktree, 'source.ts'), 'utf8')).toContain('preserved');
      expect(await readFile(path.join(p.worktree, 'regression.test.ts'), 'utf8')).toContain(
        'blankRowsCovered',
      );
      expect(await readFile(path.join(p.worktree, 'saved-note.txt'), 'utf8')).toContain(
        'B supplemental',
      );
      const bytes = await f.cm.readFile('3'.repeat(64), '/autopod/recovery/handoff.json');
      expect(bytes).toBe(await readFile(p.packet, 'utf8'));
      expect(bytes).toBe(preview.workerBrief);
      expect(p.packetHash).toBe(preview.workerBriefHash);
      const packet = JSON.parse(bytes);
      expect(packet.continuationInstruction).toBe(RECOVERY_CONTINUATION_INSTRUCTION);
      expect(packet.optionalOperatorNote).toBe('');
      expect(packet.originalFrozenHandoffInstructions).toContain('parser compatibility');
      expect(packet.quotedHistoricalContext.attempts[0].podId).toBe(a.id);
      expect(JSON.stringify(packet.quotedHistoricalContext.attempts)).toContain('Attempt A');
      expect(JSON.stringify(packet.quotedHistoricalContext)).toContain('Attempt B');
      expect(packet.nextSteps).toContain('next unfinished step');
      expect(packet.source.head).toBe(bHead);
      expect(packet.importedSupplementalFiles).toEqual([
        {
          path: 'inherited-note.txt',
          sha256: recoveryBytesHash('B revised inherited supplemental edit\n'),
          size: Buffer.byteLength('B revised inherited supplemental edit\n'),
        },
        {
          path: 'saved-note.txt',
          sha256: recoveryBytesHash(await readFile(path.join(p.worktree, 'saved-note.txt'))),
          size: Buffer.byteLength('Safely captured B supplemental edit\n'),
        },
      ]);
      expect(packet.priorSupplementalIdentities[0]).toMatchObject({
        path: 'inherited-note.txt',
        sha256: recoveryBytesHash('A saved supplemental edit\n'),
        sourcePodId: a.id,
      });
      expect(await readFile(path.join(p.worktree, 'inherited-note.txt'), 'utf8')).toBe(
        'B revised inherited supplemental edit\n',
      );
      expect(packet.quotedHistoricalContext.omissions.length).toBeGreaterThan(0);
      workerInspected = true;
      yield {
        type: 'error' as const,
        timestamp: new Date().toISOString(),
        message: 'Synthetic C stop after byte assertions',
        fatal: true,
      };
    });
    const second = await f.manager.createRecoveryFork(b.id, request, f.actor);
    expect((await f.manager.createRecoveryFork(b.id, request, f.actor)).childPodId).toBe(
      second.childPodId,
    );
    await expect(
      f.manager.createRecoveryFork(b.id, { ...request, id: 'competing' }, f.actor),
    ).rejects.toThrow('conflict');
    await f.manager.processPod(second.childPodId!);
    expect(workerInspected).toBe(true);
    const c = f.ctx.podRepo.getOrThrow(second.childPodId!);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(c.id).taskId).toBe(
      f.ctx.podRepo.taskExecutions!.snapshot(a.id).taskId,
    );
    expect(f.ctx.podRepo.taskExecutions!.snapshot(c.id).recordedTotalTokens).toBeGreaterThanOrEqual(
      70,
    );
    expect(c.worktreePath).not.toBe(b.worktreePath);
    expect(c).toMatchObject({
      prUrl: null,
      linkedPodId: null,
      autoApprove: false,
      skipValidation: false,
    });
    expect(c.validationAttempts).toBe(b.validationAttempts);
    expect(f.pod()).toEqual(a);
    expect(await readFile(path.join(a.worktreePath!, 'inherited-note.txt'), 'utf8')).toBe(
      'A saved supplemental edit\n',
    );
    expect(f.ctx.podRepo.recoveryForks!.lineage(c.id).map((row) => row.parentPodId)).toEqual([
      b.id,
      a.id,
    ]);
    const volumes = vi.mocked(f.cm.spawn).mock.calls.at(-1)![0].volumes!;
    expect(JSON.stringify(volumes)).not.toContain(
      f.ctx.podRepo.recoveryForks!.parent(b.id)!.facts.prepared!.snapshot,
    );
  });

  it('prepares a durable brief-only packet for unknown ownership without touching any old resource or admitting execution', async () => {
    const f = await fixture();
    f.ctx.podRepo.completionJournal!.begin(f.pod());
    const unknown = f.ctx.podRepo.taskExecutions!.beginRun(
      f.podId,
      f.pod().lifecycleGeneration,
      f.pod().finalization!.cycle,
      {
        runtime: f.pod().runtime,
        model: f.pod().model,
        providerAccountId: 'account',
        resource: { containerId: f.containerId, executionTarget: 'local' },
      },
    );
    f.ctx.podRepo.taskExecutions!.retainUnverifiedRun(unknown);
    f.cm.getStatus = vi.fn(async () => {
      throw new Error('Old resource must not be probed');
    });
    f.cm.getResourceKey = vi.fn(async () => {
      throw new Error('Old key must not be probed');
    });
    const before = f.ctx.db.prepare('SELECT COUNT(*) AS n FROM pods').get();
    const request = { expectedGeneration: f.pod().lifecycleGeneration, instructions: '' };
    const receipt = await f.manager.prepareRecoveryHandoff(f.podId, request, f.actor);
    expect(receipt).toMatchObject({ coverage: 'brief-only', source: null, workerStarted: false });
    expect(receipt.packet).toContain('Brief only');
    expect((await f.manager.getPreparedRecoveryHandoff(f.podId)).receipt).toEqual(receipt);
    expect(await f.manager.prepareRecoveryHandoff(f.podId, request, f.actor)).toEqual(receipt);
    await expect(
      f.manager.prepareRecoveryHandoff(
        f.podId,
        { ...request, instructions: 'Different selection' },
        f.actor,
      ),
    ).rejects.toThrow('already saved');
    const filename = path.join(f.root, 'preparation-restart.db');
    await writeFile(filename, f.ctx.db.serialize());
    const reopened = openTestDiskDatabase(filename);
    try {
      expect(
        createRecoveryForkRepository(reopened).preparation(f.podId, request.expectedGeneration),
      ).toEqual(receipt);
      const snapshots = createLaunchSnapshotRepository(
        reopened,
        createConfigurationStore(reopened),
      );
      const restarted = createPodManager({
        ...f.ctx.deps,
        podRepo: createPodRepository(reopened),
        eventRepo: createEventRepository(reopened),
        launchConfiguration: { ...f.launch, read: (id) => snapshots.get(id), goals: undefined },
      });
      expect((await restarted.getPreparedRecoveryHandoff(f.podId)).receipt).toEqual(receipt);
      expect(
        reopened
          .prepare("SELECT COUNT(*) AS n FROM recovery_fork_facts WHERE kind='admitted'")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      reopened.close();
    }
    const view = await f.manager.inspectRecoveryFork(f.podId);
    expect(view.available).toBe(false);
    await expect(
      f.manager.createRecoveryFork(
        f.podId,
        { ...f.input, id: 'blocked-start', expectedBinding: 'a'.repeat(64) },
        f.actor,
      ),
    ).rejects.toThrow();
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.cm.getResourceKey).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.launch.prepareEnvironment).not.toHaveBeenCalled();
    expect(f.ctx.db.prepare('SELECT COUNT(*) AS n FROM pods').get()).toEqual(before);
  });

  it('prepares only independently saved Git objects while the original worker and its later edits remain inaccessible', async () => {
    const f = await fixture();
    const objectStore = path.join(f.root, 'independently-saved.git');
    await git(f.root, 'clone', '--bare', '--no-local', f.pod().worktreePath!, objectStore);
    const head = await git(objectStore, 'rev-parse', 'HEAD');
    const tree = await git(objectStore, 'rev-parse', 'HEAD^{tree}');
    const ref = `refs/autopod-quarantine/${f.podId}/1-committed`;
    await git(objectStore, 'update-ref', ref, head);
    const now = new Date().toISOString();
    await f.ctx.podRepo.savedWorkspaceCheckpoints!.save({
      podId: f.podId,
      sequence: 1,
      fingerprint: { head, tree, dirty: false },
      verifiedAt: null,
      capturedAt: now,
      attempts: 1,
      error: undefined,
      result: {
        sequence: 1,
        sourceHead: head,
        sourceTree: tree,
        snapshotCommit: head,
        snapshotTree: tree,
        transferVerified: true,
        bundleVerified: true,
        hostImported: true,
        lineageVerified: true,
        promoted: false,
        materialized: false,
        quarantineRef: ref,
        objectStore,
      },
    });
    await writeFile(
      path.join(f.pod().worktreePath!, 'source.ts'),
      'Later unsynced edit must not be claimed\n',
    );
    f.ctx.podRepo.completionJournal!.begin(f.pod());
    f.cm.getStatus = vi.fn(async () => {
      throw new Error('No old resource probe');
    });
    f.cm.getResourceKey = vi.fn(async () => {
      throw new Error('No old resource key');
    });
    f.worktrees.inspectSourceAdoption.mockImplementation(async () => {
      throw new Error('No live checkout inspection');
    });
    const receipt = await f.manager.prepareRecoveryHandoff(
      f.podId,
      { expectedGeneration: f.pod().lifecycleGeneration },
      f.actor,
    );
    expect(receipt.coverage).toBe('saved-checkpoint');
    expect(receipt.source).toMatchObject({ podId: f.podId, head, tree });
    expect(receipt.packet).toContain('Later, unsynced');
    const row = f.ctx.db
      .prepare('SELECT archive_path AS archive FROM fresh_handoff_preparations WHERE pod_id=?')
      .get(f.podId) as { archive: string };
    const imported = path.join(f.root, 'inspect-prepared-copy');
    await git(f.root, 'init', imported);
    await git(
      imported,
      'fetch',
      '--no-write-fetch-head',
      row.archive,
      `${ref}:refs/heads/prepared`,
    );
    await git(imported, 'checkout', 'prepared');
    expect(await readFile(path.join(imported, 'source.ts'), 'utf8')).toContain('preserved');
    expect(await readFile(path.join(f.pod().worktreePath!, 'source.ts'), 'utf8')).toContain(
      'Later unsynced',
    );
    expect(f.worktrees.inspectSourceAdoption).not.toHaveBeenCalled();
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.cm.getResourceKey).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    await writeFile(row.archive, 'tampered bundle');
    await expect(f.manager.getPreparedRecoveryHandoff(f.podId)).rejects.toThrow('bytes changed');
  });

  it.each([
    'foreign-task',
    'cycle',
    'stale-launch',
  ] as const)('rejects %s lineage before another successor can be admitted', async (kind) => {
    const f = await fixture();
    const operation = await f.manager.createRecoveryFork(f.podId, await f.request(), f.actor);
    const record = f.ctx.podRepo.recoveryForks!.parent(f.podId)!;
    // Corrupt synthetic disk data, never relax a production admission guard.
    f.ctx.db.exec('DROP TRIGGER recovery_forks_immutable_update');
    if (kind === 'cycle')
      f.ctx.db
        .prepare('UPDATE recovery_forks SET parent_pod_id=? WHERE id=?')
        .run(operation.childPodId, record.id);
    else
      f.ctx.db
        .prepare('UPDATE recovery_forks SET binding=json_set(binding,?,?) WHERE id=?')
        .run(kind === 'foreign-task' ? '$.taskId' : '$.execution.digest', 'foreign', record.id);
    expect(() => f.ctx.podRepo.recoveryForks!.lineage(operation.childPodId!)).toThrow();
    await expect(f.manager.inspectRecoveryFork(operation.childPodId!)).rejects.toThrow();
    expect(
      f.ctx.db.prepare("SELECT COUNT(*) AS n FROM recovery_fork_facts WHERE kind='admitted'").get(),
    ).toEqual({ n: 1 });
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });

  it('refuses an older clean host checkout when a newer independently imported checkpoint exists', async () => {
    const f = await fixture();
    const source = f.pod().worktreePath!;
    const old = await git(source, 'rev-parse', 'HEAD');
    await writeFile(
      path.join(source, 'newer-regression.ts'),
      'export const newerSavedWork = true;\n',
    );
    await git(source, 'add', 'newer-regression.ts');
    await git(
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Newer independently saved work',
    );
    const head = await git(source, 'rev-parse', 'HEAD');
    const tree = await git(source, 'rev-parse', 'HEAD^{tree}');
    const now = new Date().toISOString();
    await f.ctx.podRepo.savedWorkspaceCheckpoints!.save({
      podId: f.podId,
      sequence: 1,
      fingerprint: { head, tree, dirty: false },
      verifiedAt: now,
      capturedAt: now,
      attempts: 1,
      error: undefined,
      result: {
        sequence: 1,
        sourceHead: head,
        sourceTree: tree,
        snapshotCommit: head,
        snapshotTree: tree,
        transferVerified: true,
        bundleVerified: true,
        hostImported: true,
        lineageVerified: true,
        promoted: false,
        materialized: false,
        quarantineRef: `refs/autopod-quarantine/${f.podId}/1`,
      },
    });
    await git(source, 'reset', '--hard', old);
    const inspection = await f.manager.inspectRecoveryFork(f.podId);
    expect(inspection.available).toBe(false);
    expect(inspection.blockers.join(' ')).toContain('latest independently saved checkpoint');
    expect(f.ctx.podRepo.recoveryForks!.parent(f.podId)).toBeNull();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });

  it('bounds recent UTF-8 history and identifies sanitized report excerpt bytes without inheriting a check', async () => {
    const f = await fixture();
    for (let i = 0; i < 110; i++)
      f.ctx.deps.eventRepo!.insert({
        type: 'pod.agent_activity',
        podId: f.podId,
        timestamp: new Date().toISOString(),
        event: {
          type: 'status',
          timestamp: new Date().toISOString(),
          message: `visible-${i}: ${'π'.repeat(2100)}`,
        },
      });
    const result = createFailingValidationResult(f.podId);
    f.ctx.podRepo.update(f.podId, {
      lastValidationResult: {
        ...result,
        setup: {
          status: 'fail',
          duration: 1,
          output: 'TOKEN=synthetic-secret\nMissing fixture launcher',
        },
      },
    });
    const inspection = await f.manager.inspectRecoveryFork(f.podId);
    expect(inspection.context.truncated).toBe(true);
    expect(inspection.context.messages.length).toBeLessThanOrEqual(100);
    expect(
      inspection.context.messages.reduce((n, message) => n + Buffer.byteLength(message.text), 0),
    ).toBeLessThanOrEqual(24000);
    expect(inspection.context.messages.at(-1)?.text).toContain('visible-109');
    const report = inspection.context.reports!.find(
      (r) => r.source === 'lastValidationResult.setup.output',
    )!;
    expect(report.text).not.toContain('synthetic-secret');
    expect(report.text).toContain('Missing fixture launcher');
    expect(report.sha256).toBe(recoveryBytesHash(report.text));
    expect(report.omissions).toContain('not a passing report');
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it.each([
    '{"password":"synthetic-not-a-real-credential"}',
    '{"type":"tool_use","input":{"command":"synthetic fixture"}}',
  ])('keeps recognizable private supplemental content out of every worker mount', async (bytes) => {
    const f = await fixture();
    await writeFile(path.join(f.pod().worktreePath!, 'supplement.json'), bytes);
    const view = await f.manager.inspectRecoveryFork(f.podId);
    const input = {
      ...f.input,
      files: view.source!.files.map(({ path, version }) => ({ path, version })),
    };
    const preview = await f.manager.previewRecoveryFork(f.podId, input);
    expect(preview.available).toBe(false);
    expect(preview.blockers.join(' ')).toContain('recognizable credentials');
    await expect(
      f.manager.createRecoveryFork(
        f.podId,
        { ...input, id: 'private-supplement', expectedBinding: 'a'.repeat(64) },
        f.actor,
      ),
    ).rejects.toThrow();
    expect(await readFile(path.join(f.pod().worktreePath!, 'supplement.json'), 'utf8')).toBe(bytes);
    expect(
      f.ctx.db.prepare("SELECT COUNT(*) AS n FROM recovery_fork_facts WHERE kind='admitted'").get(),
    ).toEqual({ n: 0 });
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
});
