import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PageResult, ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockContainerManager,
  createPassingValidationResult,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createScreenshotStore } from './screenshot-store.js';
import { sourcePodFingerprint } from './source-adoption-repository.js';
import { createValidationEvidence } from './validation-evidence.js';
import { assertValidationResourceSettled } from './validation-execution-evidence.js';
import { validationResultHash } from './validation-execution-ledger.js';
import { createValidationExecutionRecovery } from './validation-execution-recovery.js';
import { captureValidationOwnership } from './validation-ownership.js';
import { createValidationPublication } from './validation-publication.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';
import { createValidationRepository } from './validation-repository.js';

const podId = 'worker';
const resource = '11111111-1111-4111-8111-111111111111';
const identity = {
  source: 'a'.repeat(64),
  contract: 'b'.repeat(64),
  commands: 'c'.repeat(64),
  environment: null,
  implementation: null,
};
const usage = { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, costUsd: 0.25 };
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Missing enrichment fixture value');
  return value;
}
const clone = (result: ValidationResult): ValidationResult => JSON.parse(JSON.stringify(result));
function page(screenshotPath: string, pagePath = '/'): PageResult {
  return {
    path: pagePath,
    screenshotPath,
    status: 'pass',
    consoleErrors: [],
    assertions: [],
    loadTime: 1,
  };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-enrichment-'));
  const worktree = path.join(root, 'worktree');
  const host = path.join(root, 'host');
  fs.mkdirSync(worktree);
  fs.mkdirSync(host);
  const file = path.join(root, 'state.db');
  const seed = createTestDb();
  try {
    insertTestProfile(seed);
    fs.writeFileSync(file, seed.serialize());
  } finally {
    seed.close();
  }
  let db = new Database(file);
  db.pragma('foreign_keys = ON');
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const connect = () => {
    const repo = createPodRepository(db);
    const ledger = required(repo.validationExecutions);
    const history = createValidationRepository(db);
    const events = createEventRepository(db);
    const bus = createEventBus(events, logger);
    const publish = createValidationPublication({
      podRepo: repo,
      validationRepo: history,
      eventBus: bus,
    }).publishValidationResult;
    const recovery = createValidationExecutionRecovery({
      podRepo: repo,
      getContainerManager: () => cm,
      isActive: () => false,
    });
    return { repo, ledger, history, events, bus, publish, recovery };
  };
  const cm = createMockContainerManager();
  const current = connect();
  current.repo.insert({
    id: podId,
    profileName: 'test-profile',
    task: 'Collect validation evidence',
    status: 'validating',
    model: 'model',
    runtime: 'claude',
    executionTarget: 'sandbox',
    branch: 'feature/evidence',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  current.repo.update(podId, { containerId: resource, worktreePath: worktree });
  const retries = required(current.repo.taskRetries);
  const admission = retries.admit(
    podId,
    current.repo.getOrThrow(podId).lifecycleGeneration,
    identity,
    'd'.repeat(64),
    [],
  );
  retries.start(admission.id);
  const dispatch = required(
    current.ledger.dispatch(current.repo.getOrThrow(podId), admission.id, 1, 'test-scope'),
  );
  const result = createPassingValidationResult(podId);
  result.executionDispatchId = dispatch;
  result.timestamp = '2026-10-18T00:00:00.000Z';
  result.reviewTokenUsage = usage;
  result.smoke.pages = [page('/workspace/page.png'), page(path.join(host, 'host.png'), '/Host')];
  result.factValidation = {
    status: 'pass',
    results: [
      {
        factId: 'visible-Fact',
        kind: 'browser-test',
        proves: ['visible'],
        artifactPath: 'fact.txt',
        command: 'test',
        passed: true,
        reasoning: 'Synthetic evidence',
        attachments: [{ kind: 'screenshot', path: 'fact.PNG' }],
      },
    ],
  };
  fs.writeFileSync(path.join(worktree, 'page.png'), Buffer.from('smoke bytes'));
  fs.writeFileSync(path.join(host, 'host.png'), Buffer.from('host bytes'));
  fs.writeFileSync(path.join(worktree, 'fact.PNG'), Buffer.from('fact bytes'));
  fs.writeFileSync(path.join(worktree, 'report.txt'), 'original report');
  const store = createScreenshotStore(path.join(root, 'data'));
  const checkpoint: Parameters<
    typeof createValidationEvidence
  >[0]['checkpointSandboxWorkspaceForPod'] = vi.fn(async () => {
    // The intermediate engine evidence must precede the guarded checkpoint.
    expect(current.ledger.unsettled(podId)).toBeNull();
    expect(current.history.getForSession(podId)).toHaveLength(0);
    return {
      sequence: 1,
      sourceHead: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      snapshotCommit: 'c'.repeat(40),
      snapshotTree: 'd'.repeat(40),
      transferVerified: true,
      bundleVerified: true,
      hostImported: true,
      lineageVerified: true,
      promoted: true,
      materialized: true,
      quarantineRef: 'refs/fixture/checkpoint',
    };
  });
  const sync = vi.fn(async () => ({ pushed: true }));
  const evidence = createValidationEvidence({
    logger,
    containerManagerFactory: { get: () => cm },
    checkpointSandboxWorkspaceForPod: checkpoint,
    syncWorkspaceBack: sync,
    screenshotStore: store,
    hostScreenshotDir: () => host,
    emitActivityStatus: vi.fn(),
    formatElapsedDuration: () => '0s',
  });
  return {
    ...current,
    root,
    worktree,
    store,
    cm,
    result,
    dispatch,
    admission,
    retries,
    checkpoint,
    sync,
    db: () => db,
    finish: () => {
      current.ledger.recordOutcome(result, dispatch);
      retries.finish(admission.id, result.overall === 'pass' ? 'pass' : 'nonretryable', 1);
    },
    collect: (assertCurrent?: () => void) =>
      evidence.collectValidationEvidence(
        podId,
        current.repo.getOrThrow(podId),
        result,
        true,
        assertCurrent,
      ),
    reopen: () => {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return connect();
    },
  };
}
function rawRows(f: ReturnType<typeof fixture>) {
  return {
    outcome: f.db().prepare('SELECT * FROM validation_dispatch_outcomes').all(),
    published: f.db().prepare('SELECT * FROM validation_dispatch_results').all(),
  };
}
function assertPublished(f: ReturnType<typeof fixture>, result: ValidationResult) {
  const repo = createPodRepository(f.db());
  expect(repo.getOrThrow(podId).lastValidationResult).toEqual(result);
  expect(repo.getOrThrow(podId).phaseTokenUsage?.review).toEqual(usage);
  const history = createValidationRepository(f.db()).getForSession(podId);
  expect(history).toHaveLength(1);
  expect(history[0]?.result).toEqual(result);
  const events = createEventRepository(f.db()).getForSession(podId, {
    type: 'pod.validation_completed',
  });
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).toMatchObject({ podId, result });
  expect(
    f.db().prepare('SELECT result_hash,result FROM validation_logical_publications').all(),
  ).toEqual([{ result_hash: validationResultHash(result), result: JSON.stringify(result) }]);
}

describe('immutable engine evidence and derived validation publication', () => {
  it('composes real admission, intermediate publication, screenshot files, final publication and SQLite replay', async () => {
    const f = fixture();
    const raw = clone(f.result);
    f.finish();
    f.publish(podId, 1, f.result, { intermediate: true });
    const original = rawRows(f);
    expect(original.outcome).toEqual([
      {
        dispatch_id: f.dispatch,
        result_hash: validationResultHash(raw),
        result: JSON.stringify(raw),
      },
    ]);
    expect(original.published).toEqual(original.outcome);
    expect(f.repo.getOrThrow(podId).lastValidationResult).toBeNull();
    expect(f.repo.getOrThrow(podId).phaseTokenUsage?.review).toEqual(usage);
    expect(f.history.getForSession(podId)).toHaveLength(0);
    expect(f.events.countForSession(podId, 'pod.validation_completed')).toBe(0);
    expect(await f.collect(() => assertValidationMutationSettled(f.repo, podId))).toBe(true);
    expect(f.checkpoint).toHaveBeenCalledOnce();
    const refs = [
      required(f.result.smoke.pages[0]?.screenshot),
      required(f.result.smoke.pages[1]?.screenshot),
      required(f.result.factValidation?.results[0]?.attachments?.[0]?.screenshot),
    ];
    expect(
      await Promise.all(refs.map(async (ref) => (await f.store.read(ref)).toString())),
    ).toEqual(['smoke bytes', 'host bytes', 'fact bytes']);
    expect(rawRows(f)).toEqual(original);
    let broadcasts = 0;
    f.bus.subscribe((event) => {
      if (event.type === 'pod.validation_completed') {
        expect(f.db().inTransaction).toBe(false);
        assertPublished(f, f.result);
        broadcasts++;
      }
    });
    f.publish(podId, 1, f.result);
    expect(broadcasts).toBe(1);
    assertPublished(f, f.result);
    const reopened = f.reopen();
    const emit = vi.spyOn(reopened.bus, 'emitAfterCommit');
    reopened.publish(podId, 1, clone(f.result));
    reopened.publish(podId, 1, raw, { intermediate: true });
    assertPublished(f, f.result);
    expect(emit).not.toHaveBeenCalled();
    expect(rawRows(f)).toEqual(original);
    expect(reopened.ledger.find(reopened.repo.getOrThrow(podId))?.id).toBe(f.dispatch);
    for (const result of [raw, f.result]) {
      const hash = validationResultHash(result);
      expect(reopened.ledger.evidence(podId, f.dispatch, hash).result).toEqual(result);
      expect(
        (await reopened.recovery.readValidationEvidence(podId, f.dispatch, hash)).result,
      ).toEqual(result);
    }
    expect(() => reopened.ledger.recordResult(f.result)).toThrow();
    expect(() =>
      reopened.ledger.evidence('other', f.dispatch, validationResultHash(f.result)),
    ).toThrow('not found');
    expect(() =>
      f.db().prepare('UPDATE validation_logical_publications SET result=?').run('{}'),
    ).toThrow('immutable');
    expect(() => f.db().prepare('DELETE FROM validation_logical_publications').run()).toThrow(
      'immutable',
    );
  });

  it('rolls back an enriched completion failure, then pins one final result after reopen', async () => {
    const f = fixture();
    f.finish();
    f.publish(podId, 1, f.result, { intermediate: true });
    await f.collect();
    const original = rawRows(f);
    f.db().exec(`CREATE TRIGGER reject_completion BEFORE INSERT ON events
      WHEN NEW.type='pod.validation_completed'
      BEGIN SELECT RAISE(ABORT,'completion insert failed'); END;`);
    expect(() => f.publish(podId, 1, f.result)).toThrow('completion insert failed');
    expect(rawRows(f)).toEqual(original);
    expect(f.db().prepare('SELECT * FROM validation_logical_publications').all()).toEqual([]);
    expect(f.repo.getOrThrow(podId).lastValidationResult).toBeNull();
    expect(f.repo.getOrThrow(podId).phaseTokenUsage?.review).toEqual(usage);
    expect(f.history.getForSession(podId)).toHaveLength(0);
    f.db().exec('DROP TRIGGER reject_completion');
    const reopened = f.reopen();
    reopened.publish(podId, 1, f.result);
    reopened.publish(podId, 1, f.result);
    assertPublished(f, f.result);
    expect(rawRows(f)).toEqual(original);
  });

  it('keeps a committed enriched event across a crash before broadcast', async () => {
    const f = fixture();
    f.finish();
    f.publish(podId, 1, f.result, { intermediate: true });
    await f.collect();
    const after = required(f.repo.afterCommit);
    vi.spyOn(f.repo, 'afterCommit').mockImplementation(() => after(() => {}));
    const listener = vi.fn();
    f.bus.subscribe(listener);
    f.publish(podId, 1, f.result);
    expect(listener).not.toHaveBeenCalled();
    assertPublished(f, f.result);
    const reopened = f.reopen();
    reopened.publish(podId, 1, f.result);
    assertPublished(f, f.result);
    const replay = reopened.events
      .getSince(0)
      .filter((event) => event.type === 'pod.validation_completed');
    expect(replay).toHaveLength(1);
    expect(replay[0]?.payload).toMatchObject({ result: f.result });
  });

  it('accepts final before intermediate using the immutable outcome as its raw record', async () => {
    const f = fixture();
    const raw = clone(f.result);
    f.finish();
    // Local file collection only: no checkpoint may run without publication.
    const pod = f.repo.getOrThrow(podId);
    pod.containerId = null;
    await createValidationEvidence({
      logger,
      containerManagerFactory: { get: () => f.cm },
      checkpointSandboxWorkspaceForPod: f.checkpoint,
      syncWorkspaceBack: f.sync,
      screenshotStore: f.store,
      emitActivityStatus: vi.fn(),
      formatElapsedDuration: () => '0s',
    }).collectValidationEvidence(podId, pod, f.result, true);
    expect(f.result.smoke.pages[0]?.screenshot).toBeDefined();
    expect(f.checkpoint).not.toHaveBeenCalled();
    f.publish(podId, 1, f.result);
    const reopened = f.reopen();
    reopened.publish(podId, 1, raw, { intermediate: true });
    reopened.publish(podId, 1, f.result);
    assertPublished(f, f.result);
    expect(rawRows(f).published).toEqual(rawRows(f).outcome);
    expect(reopened.ledger.evidence(podId, f.dispatch, validationResultHash(raw)).result).toEqual(
      raw,
    );
  });

  it.each(['pass', 'fail'] as const)(
    'retains direct %s publication without an outcome or intermediate record',
    (overall) => {
      const f = fixture();
      f.result.overall = overall;
      f.retries.finish(f.admission.id, overall === 'pass' ? 'pass' : 'nonretryable', 1);
      f.publish(podId, 1, f.result);
      const raw = rawRows(f);
      expect(raw.outcome).toEqual([]);
      expect(raw.published).toEqual([
        {
          dispatch_id: f.dispatch,
          result_hash: validationResultHash(f.result),
          result: JSON.stringify(f.result),
        },
      ]);
      const reopened = f.reopen();
      reopened.publish(podId, 1, f.result, { intermediate: true });
      reopened.publish(podId, 1, f.result);
      assertPublished(f, f.result);
      expect(rawRows(f)).toEqual(raw);
    },
  );

  it('preserves engine refs and their stored bytes while collecting missing refs, including duplicate paths', async () => {
    const f = fixture();
    const smoke = await f.store.write(
      podId,
      'smoke',
      'original.png',
      Buffer.from('original smoke'),
    );
    const fact = await f.store.write(podId, 'fact', 'original.png', Buffer.from('original fact'));
    required(f.result.smoke.pages[0]).screenshot = smoke;
    required(f.result.factValidation?.results[0]?.attachments?.[0]).screenshot = fact;
    f.result.smoke.pages.push(page('/workspace/page.png'));
    const raw = clone(f.result);
    f.finish();
    f.publish(podId, 1, f.result, { intermediate: true });
    await f.collect();
    expect(f.result.smoke.pages[0]?.screenshot).toBe(smoke);
    expect(f.result.factValidation?.results[0]?.attachments?.[0]?.screenshot).toBe(fact);
    expect(f.result.smoke.pages[2]?.screenshot?.filename).toBe('2-root.png');
    expect((await f.store.read(smoke)).toString()).toBe('original smoke');
    expect((await f.store.read(fact)).toString()).toBe('original fact');
    f.publish(podId, 1, f.result);
    assertPublished(f, f.result);
    const changed = clone(f.result);
    required(changed.smoke.pages[0]).screenshot = undefined;
    expect(() => f.publish(podId, 1, changed)).toThrow();
    const replaced = clone(f.result);
    required(replaced.factValidation?.results[0]?.attachments?.[0]).screenshot = smoke;
    expect(() => f.publish(podId, 1, replaced)).toThrow();
    expect(f.ledger.evidence(podId, f.dispatch, validationResultHash(raw)).result).toEqual(raw);
  });

  it('retains existing duplicate-path collection semantics without reordering engine pages', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('/workspace/page.png'), page('/workspace/page.png')];
    const raw = clone(f.result);
    f.finish();
    f.publish(podId, 1, f.result, { intermediate: true });
    await f.collect();
    expect(f.result.smoke.pages[0]?.screenshot?.filename).toBe('1-root.png');
    expect(f.result.smoke.pages[1]?.screenshot).toBeUndefined();
    f.publish(podId, 1, f.result);
    assertPublished(f, f.result);
    expect(f.ledger.evidence(podId, f.dispatch, validationResultHash(raw)).result).toEqual(raw);
  });

  it.each(['exact', 'case-alias'] as const)(
    'does not overwrite a retained screenshot through another attachment with a %s store filename',
    async (mode) => {
      const f = fixture();
      const ref = await f.store.write(
        podId,
        'fact',
        mode === 'exact' ? 'visible-Fact-0-fact.png' : 'visible-fact-0-fact.png',
        Buffer.from('original fact'),
      );
      const fact = required(f.result.factValidation?.results[0]);
      required(fact.attachments?.[0]).screenshot = ref;
      required(f.result.factValidation).results.push({
        ...fact,
        attachments: [{ kind: 'screenshot', path: 'fact.PNG' }],
      });
      f.finish();
      f.publish(podId, 1, f.result, { intermediate: true });
      await f.collect();
      expect(fact.attachments?.[0]?.screenshot).toBe(ref);
      expect((await f.store.read(ref)).toString()).toBe('original fact');
      expect(f.result.factValidation?.results[1]?.attachments?.[0]?.screenshot).toBeUndefined();
      f.publish(podId, 1, f.result);
      assertPublished(f, f.result);
    },
  );

  it('rejects changes to engine fields, identity, array order, paths, usage and screenshot metadata before and after final publication', async () => {
    const f = fixture();
    const fact = required(f.result.factValidation?.results[0]);
    required(fact.attachments).push({ kind: 'report', path: 'report.txt' });
    required(f.result.factValidation).results.push({
      ...fact,
      factId: 'another-fact',
      attachments: [{ kind: 'log', path: 'report.txt' }],
    });
    f.finish();
    f.publish(podId, 1, f.result, { intermediate: true });
    await f.collect();
    const original = rawRows(f);
    const mutations: Array<(result: ValidationResult) => void> = [
      (r) => {
        r.podId = 'other';
      },
      (r) => {
        r.attempt = 2;
      },
      (r) => {
        r.executionDispatchId = 'other';
      },
      (r) => {
        r.duration++;
      },
      (r) => {
        r.timestamp = '2026-10-19T00:00:00.000Z';
      },
      (r) => {
        r.overall = 'fail';
      },
      (r) => {
        required(r.smoke.pages[0]).path = '/changed';
      },
      (r) => {
        required(r.smoke.pages[0]).screenshotPath = '/workspace/changed.png';
      },
      (r) => {
        r.smoke.pages.reverse();
      },
      (r) => {
        r.smoke.pages.push(page('extra.png', '/extra'));
      },
      (r) => {
        required(r.factValidation?.results[0]).factId = 'other';
      },
      (r) => {
        required(r.factValidation?.results[0]?.attachments?.[0]).path = 'other.png';
      },
      (r) => {
        required(r.factValidation?.results[0]?.attachments?.[0]).kind = 'artifact';
      },
      (r) => {
        required(r.factValidation).results.reverse();
      },
      (r) => {
        required(required(r.factValidation?.results[0]).attachments).reverse();
      },
      (r) => {
        required(r.factValidation).results.pop();
      },
      (r) => {
        required(r.reviewTokenUsage).inputTokens++;
      },
      (r) => {
        required(required(r.smoke.pages[0]).screenshot).source = 'review';
      },
      (r) => {
        required(required(r.smoke.pages[0]).screenshot).podId = 'other';
      },
      (r) => {
        required(required(r.smoke.pages[0]).screenshot).relativePath = '../other.png';
      },
      (r) => {
        required(required(r.smoke.pages[0]).screenshot).filename = 'other.png';
      },
      (r) => {
        r.infrastructureFailure = {
          phase: 'test',
          code: 'EXEC_EXIT_UNVERIFIED',
          message: 'Unknown exit',
          retryable: false,
        };
      },
    ];
    for (const final of [false, true]) {
      if (final) f.publish(podId, 1, f.result);
      for (const mutate of mutations) {
        const changed = clone(f.result);
        mutate(changed);
        expect(() => f.publish(podId, 1, changed)).toThrow();
      }
      expect(() => f.publish('other', 1, f.result)).toThrow('exact dispatch identity');
      expect(() => f.publish(podId, 2, f.result)).toThrow('exact dispatch identity');
      expect(rawRows(f)).toEqual(original);
      expect(f.repo.getOrThrow(podId).phaseTokenUsage?.review).toEqual(usage);
      expect(f.history.getForSession(podId)).toHaveLength(final ? 1 : 0);
      expect(f.events.countForSession(podId, 'pod.validation_completed')).toBe(final ? 1 : 0);
    }
    // Removing enrichment still compares equal to raw, but cannot replace the
    // pinned final publication. Even another legitimate duplicate ref is rejected.
    const removed = clone(f.result);
    required(removed.smoke.pages[0]).screenshot = undefined;
    expect(() => f.publish(podId, 1, removed)).toThrow('publication is immutable');
    assertPublished(f, f.result);
    const reopened = f.reopen();
    expect(() => reopened.publish(podId, 1, removed)).toThrow('publication is immutable');
    assertPublished(f, f.result);
  });

  it('pins the first legitimate duplicate screenshot choice and rejects a different legitimate choice on replay', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('/workspace/page.png'), page('/workspace/page.png')];
    f.finish();
    f.publish(podId, 1, f.result, { intermediate: true });
    await f.collect();
    f.publish(podId, 1, f.result);
    const changed = clone(f.result);
    required(changed.smoke.pages[0]).screenshot = await f.store.write(
      podId,
      'smoke',
      '0-root.png',
      Buffer.from('smoke bytes'),
    );
    expect(() => f.publish(podId, 1, changed)).toThrow('publication is immutable');
    const reopened = f.reopen();
    expect(() => reopened.publish(podId, 1, changed)).toThrow('publication is immutable');
    assertPublished(f, f.result);
  });

  it.each(['completed-failure', 'unknown-exit', 'unknown-cleanup'] as const)(
    'publishes %s truthfully without allowing screenshot metadata to clear resource custody',
    async (kind) => {
      const f = fixture();
      f.result.overall = 'fail';
      f.result.test = { status: 'fail', duration: 1, stdout: 'Original failed assertion' };
      f.result.infrastructureFailure = {
        phase: 'test',
        code: kind === 'unknown-exit' ? 'EXEC_EXIT_UNVERIFIED' : 'EXEC_TIMEOUT',
        message: 'Original failed command',
        retryable: false,
        execution: {
          cause: 'timeout',
          timeoutMs: 10,
          cleanup: kind === 'unknown-cleanup' ? 'unverified' : 'confirmed',
          ...(kind !== 'unknown-exit' ? { observedExitCode: 124 } : {}),
        },
      };
      const raw = clone(f.result);
      f.finish();
      const held = kind !== 'completed-failure';
      if (!held) f.publish(podId, 1, f.result, { intermediate: true });
      expect(await f.collect()).toBe(!held);
      expect(f.checkpoint).toHaveBeenCalledTimes(held ? 0 : 1);
      if (held) expect(await f.store.list(podId)).toEqual([]);
      f.publish(podId, 1, f.result);
      f.repo.update(podId, { status: 'review_required' });
      const original = rawRows(f);
      assertPublished(f, f.result);
      const reopened = f.reopen();
      reopened.publish(podId, 1, f.result);
      expect(reopened.ledger.find(reopened.repo.getOrThrow(podId))?.id).toBe(f.dispatch);
      if (!held) {
        expect(reopened.ledger.unsettled(podId)).toBeNull();
        expect(() => reopened.ledger.assertTaskSettled(podId)).not.toThrow();
      } else {
        expect(reopened.ledger.unsettled(podId)).toMatchObject({ id: f.dispatch, published: true });
        expect(() => assertValidationResourceSettled(f.db(), resource)).toThrow();
        expect(() => assertValidationMutationSettled(reopened.repo, podId)).toThrow();
        expect(() => reopened.repo.deletionOwnership?.acquire(podId, 'delete')).toThrow();
        expect(() => reopened.repo.delete(podId)).toThrow();
        expect(() => reopened.ledger.startDeletion(f.dispatch)).toThrow('immutable final');
        expect(() => reopened.ledger.settle(reopened.repo.getOrThrow(podId), 'now')).toThrow(
          'immutable final',
        );
        expect(reopened.recovery.getValidationExecutionRecovery(podId)).toMatchObject({
          allowed: false,
          settled: false,
          code: 'VALIDATION_FINAL_CONTENT_UNVERIFIED',
        });
        await expect(
          reopened.recovery.readValidationEvidence(
            podId,
            f.dispatch,
            validationResultHash(raw),
            'report.txt',
          ),
        ).rejects.toThrow('No verified report snapshot');
        const cleared = clone(f.result);
        cleared.infrastructureFailure = undefined;
        expect(() => reopened.publish(podId, 1, cleared)).toThrow();
        const decorated = clone(f.result);
        required(decorated.smoke.pages[0]).screenshot = {
          podId,
          source: 'smoke',
          filename: '0-root.png',
          relativePath: `screenshots/${podId}/smoke/0-root.png`,
        };
        expect(() => reopened.publish(podId, 1, decorated)).toThrow();
        // A mutable projection cannot release the immutable original dispatch.
        reopened.repo.update(podId, { containerId: null, lastValidationResult: cleared });
        expect(() => reopened.ledger.assertTaskSettled(podId)).toThrow();
        expect(() => assertValidationResourceSettled(f.db(), resource)).toThrow();
        expect(reopened.repo.listReferencedContainerIds()).toContain(resource);
      }
      expect(rawRows(f)).toEqual(original);
      expect(fs.readFileSync(path.join(f.worktree, 'report.txt'), 'utf8')).toBe('original report');
      expect(f.cm.start).not.toHaveBeenCalled();
      expect(f.cm.execInContainer).not.toHaveBeenCalled();
      expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
      expect(f.cm.kill).not.toHaveBeenCalled();
      expect(f.sync).not.toHaveBeenCalled();
      expect(reopened.ledger.isSettled(reopened.repo.getOrThrow(podId))).toBe(false);
    },
  );

  it.each(['source', 'cleanup', 'lifecycle'] as const)(
    'rechecks %s ownership after awaited screenshot storage before checkpoint or final publication',
    async (fence) => {
      const f = fixture();
      f.finish();
      f.publish(podId, 1, f.result, { intermediate: true });
      const raw = rawRows(f);
      const pod = f.repo.getOrThrow(podId);
      const ownership = captureValidationOwnership(pod, {
        readCurrent: () => {
          f.repo.sourceAdoptions?.assertAvailable(podId);
          f.repo.deletionOwnership?.assertTaskAvailable(podId);
          return f.repo.getOrThrow(podId);
        },
        isCurrentInvocation: () => true,
        hasPendingDecision: () => false,
      });
      const write = f.store.write.bind(f.store);
      vi.spyOn(f.store, 'write').mockImplementationOnce(async (...args) => {
        const ref = await write(...args);
        if (fence === 'lifecycle') f.repo.incrementLifecycleGeneration(podId);
        if (fence === 'cleanup')
          f.db()
            .prepare(`
          INSERT INTO deletion_cleanup_intents(id,pod_id,task_id,identity,created_at)
          SELECT 'cleanup-owner',pod_id,task_id,'identity','now' FROM task_executions WHERE pod_id=?
        `)
            .run(podId);
        if (fence === 'source')
          required(f.repo.sourceAdoptions).claim(
            'source-owner',
            podId,
            {
              generation: pod.lifecycleGeneration,
              fingerprint: sourcePodFingerprint(pod),
              repository: 'https://github.com/org/repo',
              branch: pod.branch,
              baseBranch: 'main',
              containerId: resource,
              resourceKey: 'test-scope',
              worktreePath: f.worktree,
              oldHead: 'a'.repeat(40),
              targetHead: 'b'.repeat(40),
            },
            { type: 'human', userId: 'operator' },
            'Preserve exact original source',
            () => {},
          );
        return ref;
      });
      await expect(
        f.collect(() => {
          ownership.assertCurrent();
          assertValidationMutationSettled(f.repo, podId);
        }),
      ).rejects.toThrow();
      expect(f.result.factValidation?.results[0]?.attachments?.[0]?.screenshot).toBeUndefined();
      expect(f.checkpoint).not.toHaveBeenCalled();
      expect(f.history.getForSession(podId)).toHaveLength(0);
      expect(f.events.countForSession(podId, 'pod.validation_completed')).toBe(0);
      expect(rawRows(f)).toEqual(raw);
      expect(f.db().prepare('SELECT * FROM validation_logical_publications').all()).toEqual([]);
      expect(f.repo.getOrThrow(podId).phaseTokenUsage?.review).toEqual(usage);
    },
  );
});
