import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PageResult, Pod, ScreenshotRef, ValidationResult } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockContainerManager,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import * as collectors from '../validation/screenshot-collector.js';
import { createPodRepository } from './pod-repository.js';
import { createScreenshotStore } from './screenshot-store.js';
import { createValidationEvidence } from './validation-evidence.js';

type FactCheckResult = NonNullable<ValidationResult['factValidation']>['results'][number];

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Expected evidence fixture value');
  return value;
}
function page(screenshotPath = '', pagePath = '/'): PageResult {
  return {
    path: pagePath,
    status: 'pass',
    screenshotPath,
    consoleErrors: [],
    assertions: [],
    loadTime: 1,
  };
}
function fact(
  id: string,
  kind: FactCheckResult['kind'] = 'browser-test',
  file = `${id}.png`,
): FactCheckResult {
  return {
    factId: id,
    kind,
    proves: ['visible'],
    artifactPath: 'artifact.txt',
    command: 'test',
    passed: true,
    reasoning: 'Synthetic fact',
    attachments: [{ kind: 'screenshot', path: file }],
  };
}
function fixture(target: Pod['executionTarget'] = 'local') {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'validation-evidence-direct-')),
  );
  const worktree = path.join(root, 'worktree');
  const host = path.join(root, 'host');
  fs.mkdirSync(worktree);
  fs.mkdirSync(host);
  const db = createTestDb();
  insertTestProfile(db);
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Evidence',
    status: 'validating',
    model: 'model',
    runtime: 'claude',
    executionTarget: target,
    branch: 'feature/evidence',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', { containerId: 'container', worktreePath: worktree });
  const pod = repo.getOrThrow('worker');
  const result: ValidationResult = {
    podId: pod.id,
    attempt: 1,
    timestamp: '2026-10-18T00:00:00Z',
    overall: 'pass',
    duration: 1,
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: '', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: null,
  };
  const cm = createMockContainerManager();
  const store = createScreenshotStore(path.join(root, 'store'));
  const messages: string[] = [];
  const order: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps: Parameters<typeof createValidationEvidence>[0] = {
    logger: log,
    screenshotStore: store,
    containerManagerFactory: { get: vi.fn(() => cm) },
    checkpointSandboxWorkspaceForPod: vi.fn(async (_pod: Pod) => {
      order.push('checkpoint');
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
    }),
    syncWorkspaceBack: vi.fn(async () => {
      order.push('sync');
      return { pushed: true };
    }),
    hostScreenshotDir: vi.fn(() => host),
    emitActivityStatus: vi.fn((id, message) => {
      expect(id).toBe('activity-id');
      messages.push(message);
      order.push(message);
    }),
    formatElapsedDuration: vi.fn((ms) => `${(ms / 1_000).toFixed(1)}s`),
  };
  return {
    root,
    worktree,
    host,
    cm,
    store,
    deps,
    log,
    pod,
    result,
    messages,
    order,
    make: () => createValidationEvidence(deps),
    run: (ok = true) =>
      createValidationEvidence(deps).collectValidationEvidence('activity-id', pod, result, ok),
    write: (file: string, bytes = file) => {
      const dest = path.resolve(worktree, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    },
    facts: (...facts: FactCheckResult[]) => {
      result.factValidation = { status: 'pass', results: facts };
    },
    attachment: (index = 0) =>
      required(required(result.factValidation?.results[index]).attachments?.[0]),
  };
}

describe('createValidationEvidence', () => {
  it.each([
    'EXEC_EXIT_UNVERIFIED',
    'AZURE_SANDBOX_EXEC_INVALID_RESPONSE',
    'VALIDATION_ENGINE_TERMINATION_UNVERIFIED',
  ])('retains physical reports without checkpoint execution after %s', async (code) => {
    const f = fixture('sandbox');
    f.write('report.txt', 'original partial failed output');
    f.result.overall = 'fail';
    f.result.infrastructureFailure = {
      phase: 'test',
      code,
      message: 'Termination unknown',
      retryable: false,
    };
    vi.mocked(f.deps.checkpointSandboxWorkspaceForPod).mockImplementation(async () => {
      f.write('report.txt', 'changed by new checkpoint commands');
      throw new Error('Checkpoint ran beside an unknown execution');
    });
    expect(await f.run()).toBe(false);
    expect(f.deps.checkpointSandboxWorkspaceForPod).not.toHaveBeenCalled();
    expect(f.deps.syncWorkspaceBack).not.toHaveBeenCalled();
    expect(f.deps.containerManagerFactory.get).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.worktree, 'report.txt'), 'utf8')).toBe(
      'original partial failed output',
    );
  });
  it('constructs without I/O and keeps separate pod and activity identifiers', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('page.png')];
    f.write('page.png', 'bytes');
    const write = vi.spyOn(f.store, 'write');
    const op = f.make();
    expect(write).not.toHaveBeenCalled();
    expect(f.deps.containerManagerFactory.get).not.toHaveBeenCalled();
    expect(f.deps.emitActivityStatus).not.toHaveBeenCalled();
    expect(await op.collectValidationEvidence('activity-id', f.pod, f.result, true)).toBe(true);
    expect(f.deps.containerManagerFactory.get).toHaveBeenCalledExactlyOnceWith('local');
    expect(f.deps.syncWorkspaceBack).toHaveBeenCalledExactlyOnceWith(
      'container',
      f.worktree,
      f.cm,
      'activity-id',
      'local',
    );
    expect(f.deps.hostScreenshotDir).toHaveBeenCalledExactlyOnceWith('worker');
    expect(write).toHaveBeenCalledWith('worker', 'smoke', '0-root.png', Buffer.from('bytes'));
    expect(f.log.info).toHaveBeenCalledWith(
      { podId: 'activity-id', count: 1 },
      'Collected validation screenshots',
    );
  });

  it.each(['no-worktree', 'no-container', 'no-store', 'no-evidence'] as const)(
    'keeps gates for %s',
    async (mode) => {
      const f = fixture();
      f.facts(fact('fact'));
      f.write('fact.png');
      f.result.smoke.pages = [page('page.png')];
      f.write('page.png');
      if (mode === 'no-worktree') f.pod.worktreePath = null;
      if (mode === 'no-container') f.pod.containerId = null;
      if (mode === 'no-store') f.deps.screenshotStore = undefined;
      if (mode === 'no-evidence') {
        f.result.factValidation = undefined;
        f.result.smoke.pages = [page()];
      }
      expect(await f.run(false)).toBe(false);
      expect(f.deps.syncWorkspaceBack).toHaveBeenCalledTimes(
        mode === 'no-worktree' || mode === 'no-container' ? 0 : 1,
      );
      expect(await f.store.list('worker')).toHaveLength(mode === 'no-container' ? 2 : 0);
      if (mode !== 'no-container') expect(f.deps.hostScreenshotDir).not.toHaveBeenCalled();
    },
  );

  it('protects all host fact bytes before sync removes files and reopens the store', async () => {
    const f = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    f.facts(fact('browser'), fact('unit', 'unit-test'));
    f.write('browser.png', 'host-browser');
    f.write('unit.png', 'host-unit');
    const write = vi.spyOn(f.store, 'write');
    vi.mocked(f.deps.syncWorkspaceBack).mockImplementation(async () => {
      expect(write).toHaveBeenCalledTimes(2);
      fs.rmSync(path.join(f.worktree, 'browser.png'));
      fs.rmSync(path.join(f.worktree, 'unit.png'));
      return { pushed: false };
    });
    expect(await f.run()).toBe(true);
    const reopened = createScreenshotStore(path.join(f.root, 'store'));
    const refs = await reopened.list('worker');
    expect(refs).toHaveLength(2);
    expect((await reopened.read(required(refs[0]))).toString()).toBe('host-browser');
    expect((await reopened.read(required(refs[1]))).toString()).toBe('host-unit');
    expect(f.attachment().screenshot).toBe(await write.mock.results[0]?.value);
    expect(f.messages).toEqual([
      'Collecting host fact evidence…',
      'Syncing post-validation workspace…',
      'Workspace sync complete (0.0s)',
      'Collecting synced fact evidence…',
    ]);
  });

  it('collects after sync and preserves original result/page/attachment reference identity', async () => {
    const f = fixture();
    f.facts(fact('unit', 'unit-test'));
    const attachment = f.attachment();
    const originalPage = page('/workspace/page.png');
    f.result.smoke.pages = [originalPage];
    const result = f.result;
    vi.mocked(f.deps.syncWorkspaceBack).mockImplementation(async () => {
      f.write('page.png', 'smoke');
      f.write('unit.png', 'fact');
      return { pushed: true };
    });
    const write = vi.spyOn(f.store, 'write');
    expect(await f.run()).toBe(true);
    expect(f.result).toBe(result);
    expect(f.result.smoke.pages[0]).toBe(originalPage);
    expect(f.attachment()).toBe(attachment);
    expect(originalPage.screenshot).toBe(await write.mock.results[0]?.value);
    expect(attachment.screenshot).toBe(await write.mock.results[1]?.value);
    expect((await f.store.read(required(originalPage.screenshot))).toString()).toBe('smoke');
    expect((await f.store.read(required(attachment.screenshot))).toString()).toBe('fact');
  });

  it('keeps fact gates computed before smoke collection mutates the result', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('page.png')];
    f.write('page.png');
    f.write('late.png');
    const write = f.store.write.bind(f.store);
    vi.spyOn(f.store, 'write').mockImplementation(async (...args) => {
      f.facts(fact('late'));
      return write(...args);
    });
    await f.run();
    expect(f.messages).not.toContain('Collecting synced fact evidence…');
    expect(f.attachment().screenshot).toBeUndefined();
  });

  it('keeps smoke gate computed before host collection adds pages', async () => {
    const f = fixture();
    f.facts(fact('browser'));
    f.write('browser.png');
    f.write('page.png');
    const write = f.store.write.bind(f.store);
    vi.spyOn(f.store, 'write').mockImplementation(async (...args) => {
      f.result.smoke.pages = [page('page.png')];
      return write(...args);
    });
    await f.run();
    expect(f.messages).not.toContain('Collecting validation screenshots…');
    expect(f.result.smoke.pages[0]?.screenshot).toBeUndefined();
  });

  it('writes a host fact filename again after sync and keeps its latest bytes', async () => {
    const f = fixture();
    f.facts(fact('browser'));
    f.write('browser.png', 'before');
    vi.mocked(f.deps.syncWorkspaceBack).mockImplementation(async () => {
      f.write('browser.png', 'after');
      return { pushed: true };
    });
    const write = vi.spyOn(f.store, 'write');
    await f.run();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.slice(0, 3)).toEqual(write.mock.calls[1]?.slice(0, 3));
    expect(f.attachment().screenshot).toBe(await write.mock.results[1]?.value);
    expect((await f.store.read(required(f.attachment().screenshot))).toString()).toBe('after');
  });

  it.each([
    'relative',
    'workspace',
    'host',
    'unrelated-absolute',
    'parent',
    'symlink',
    'missing',
  ] as const)('uses real smoke containment for %s', async (mode) => {
    const f = fixture();
    f.write('page.png', 'inside');
    fs.writeFileSync(path.join(f.host, 'page.png'), 'host');
    fs.writeFileSync(path.join(f.root, 'outside.png'), 'outside');
    fs.symlinkSync(path.join(f.root, 'outside.png'), path.join(f.worktree, 'link.png'));
    const values = {
      relative: 'page.png',
      workspace: '/workspace/page.png',
      host: path.join(f.host, 'page.png'),
      'unrelated-absolute': path.join(f.root, 'outside.png'),
      parent: '../outside.png',
      symlink: 'link.png',
      missing: 'missing.png',
    };
    f.result.smoke.pages = [page(values[mode])];
    await f.run();
    const accepted = ['relative', 'workspace', 'host'].includes(mode);
    expect(await f.store.list('worker')).toHaveLength(accepted ? 1 : 0);
    const ref = f.result.smoke.pages[0]?.screenshot;
    if (accepted)
      expect((await f.store.read(required(ref))).toString()).toBe(
        mode === 'host' ? 'host' : 'inside',
      );
    else {
      expect(ref).toBeUndefined();
      expect(f.log.warn).toHaveBeenCalledWith(
        { podId: 'activity-id', missingCount: 1, collectedCount: 0 },
        'Validation page screenshots were reported but not collected',
      );
    }
  });

  it.each(['uppercase', 'absolute', 'non-png', 'symlink', 'parent', 'not-screenshot'] as const)(
    'uses real fact gates and containment for %s',
    async (mode) => {
      const f = fixture();
      f.write('fact.PNG', 'inside');
      fs.writeFileSync(path.join(f.root, 'outside.png'), 'outside');
      fs.symlinkSync(path.join(f.root, 'outside.png'), path.join(f.worktree, 'link.png'));
      const values = {
        uppercase: 'fact.PNG',
        absolute: path.join(f.worktree, 'fact.PNG'),
        'non-png': 'fact.jpg',
        symlink: 'link.png',
        parent: '../outside.png',
        'not-screenshot': 'fact.PNG',
      };
      f.facts(fact('fact', 'browser-test', values[mode]));
      if (mode === 'not-screenshot') f.attachment().kind = 'artifact';
      await f.run();
      expect(await f.store.list('worker')).toHaveLength(mode === 'uppercase' ? 1 : 0);
      expect(f.messages.includes('Collecting host fact evidence…')).toBe(
        ['uppercase', 'symlink', 'parent'].includes(mode),
      );
      if (mode === 'uppercase')
        expect((await f.store.read(required(f.attachment().screenshot))).toString()).toBe('inside');
    },
  );

  it('keeps first-page duplicate matching, ref identity and missing counts', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('first.png'), page('second.png'), page('absent.png', '/missing')];
    f.write('first.png', 'first');
    f.write('second.png', 'second');
    const write = vi.spyOn(f.store, 'write');
    await f.run();
    expect(f.result.smoke.pages[0]?.screenshot).toBe(await write.mock.results[1]?.value);
    expect(f.result.smoke.pages[1]?.screenshot).toBeUndefined();
    expect(await f.store.list('worker')).toHaveLength(2);
    expect(f.log.warn).toHaveBeenCalledWith(
      { podId: 'activity-id', missingCount: 2, collectedCount: 2 },
      'Validation page screenshots were reported but not collected',
    );
  });

  it('retains existing refs when a page cannot be recollected', async () => {
    const f = fixture();
    const ref: ScreenshotRef = {
      podId: 'old',
      source: 'smoke',
      filename: 'old.png',
      relativePath: 'old.png',
    };
    f.result.smoke.pages = [{ ...page('missing.png'), screenshot: ref }];
    await f.run();
    expect(f.result.smoke.pages[0]?.screenshot).toBe(ref);
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it.each(
    Array.from({ length: 8 }, (_, i) => ({
      promoted: !!(i & 1),
      materialized: !!(i & 2),
      lineageVerified: !!(i & 4),
    })),
  )(
    'returns the exact sandbox receipt conjunction $promoted/$materialized/$lineageVerified',
    async (flags) => {
      const f = fixture('sandbox');
      const original = required(
        vi.mocked(f.deps.checkpointSandboxWorkspaceForPod).getMockImplementation(),
      );
      vi.mocked(f.deps.checkpointSandboxWorkspaceForPod).mockImplementation(async (pod) => ({
        ...(await original(pod)),
        ...flags,
      }));
      expect(await f.run(false)).toBe(
        flags.promoted && flags.materialized && flags.lineageVerified,
      );
      expect(f.deps.checkpointSandboxWorkspaceForPod).toHaveBeenCalledExactlyOnceWith(f.pod);
      expect(f.deps.containerManagerFactory.get).not.toHaveBeenCalled();
      expect(f.deps.syncWorkspaceBack).not.toHaveBeenCalled();
      expect(f.messages.some((m) => m.startsWith('Workspace sync complete'))).toBe(true);
    },
  );

  it.each([true, false])('preserves incoming %s on non-sandbox successful transfer', async (ok) => {
    const f = fixture();
    expect(await f.run(ok)).toBe(ok);
  });

  it.each(['factory', 'transfer', 'checkpoint'] as const)(
    'degrades after thrown %s and still collects facts',
    async (mode) => {
      const f = fixture(mode === 'checkpoint' ? 'sandbox' : 'local');
      const error = new Error(mode);
      f.facts(fact('unit', 'unit-test'));
      f.write('unit.png');
      if (mode === 'factory')
        vi.mocked(f.deps.containerManagerFactory.get).mockImplementation(() => {
          throw error;
        });
      if (mode === 'transfer') vi.mocked(f.deps.syncWorkspaceBack).mockRejectedValue(error);
      if (mode === 'checkpoint')
        vi.mocked(f.deps.checkpointSandboxWorkspaceForPod).mockRejectedValue(error);
      expect(await f.run()).toBe(false);
      expect(f.messages).toContain('Collecting available fact evidence after degraded sync…');
      expect(f.attachment().screenshot).toBeDefined();
      expect(f.log.warn).toHaveBeenCalledWith(
        { err: error, podId: 'activity-id' },
        'Failed to sync workspace after validation',
      );
    },
  );

  it('formats measured duration at the current clock without sleeping', async () => {
    const f = fixture();
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(1350);
    await f.run();
    expect(f.deps.formatElapsedDuration).toHaveBeenCalledExactlyOnceWith(1250);
    expect(f.messages).toContain('Workspace sync complete (1.3s)');
  });

  it('captures store/resolver references but looks up the current factory method at sync time', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('page.png')];
    f.write('page.png');
    const resolver = f.deps.hostScreenshotDir;
    const write = vi.spyOn(f.store, 'write');
    const op = f.make();
    const replacement = createScreenshotStore(path.join(f.root, 'other-store'));
    f.deps.screenshotStore = replacement;
    f.deps.hostScreenshotDir = vi.fn(() => {
      throw new Error('replacement resolver should not run');
    });
    const get = vi.fn(() => f.cm);
    f.deps.containerManagerFactory.get = get;
    await op.collectValidationEvidence('activity-id', f.pod, f.result, true);
    expect(get).toHaveBeenCalledExactlyOnceWith('local');
    expect(resolver).toHaveBeenCalledExactlyOnceWith('worker');
    expect(f.deps.hostScreenshotDir).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(await replacement.list('worker')).toEqual([]);
  });

  it('swallows a resolver error and proceeds to fact collection', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('page.png')];
    f.facts(fact('unit', 'unit-test'));
    f.write('unit.png');
    const error = new Error('resolver');
    f.deps.hostScreenshotDir = () => {
      throw error;
    };
    expect(await f.run()).toBe(true);
    expect(f.attachment().screenshot).toBeDefined();
    expect(f.log.warn).toHaveBeenCalledWith(
      { err: error, podId: 'activity-id' },
      'Failed to collect screenshots',
    );
  });

  it.each(['host', 'smoke', 'fact'] as const)(
    'catches a thrown %s collector with the original continuation',
    async (stage) => {
      const f = fixture();
      f.facts(fact('browser'));
      f.write('browser.png');
      f.result.smoke.pages = [page('page.png')];
      f.write('page.png');
      const error = new Error(stage);
      if (stage === 'smoke')
        vi.spyOn(collectors, 'collectScreenshots').mockRejectedValueOnce(error);
      else {
        const original = collectors.collectFactScreenshots;
        const spy = vi.spyOn(collectors, 'collectFactScreenshots');
        if (stage === 'fact') spy.mockImplementationOnce(original);
        spy.mockRejectedValueOnce(error);
      }
      expect(await f.run()).toBe(true);
      const labels = {
        host: 'Failed to collect host fact screenshots',
        smoke: 'Failed to collect screenshots',
        fact: 'Failed to collect fact screenshots',
      };
      expect(f.log.warn).toHaveBeenCalledWith({ err: error, podId: 'activity-id' }, labels[stage]);
      expect(f.deps.syncWorkspaceBack).toHaveBeenCalledOnce();
      expect(f.messages).toContain('Collecting synced fact evidence…');
    },
  );

  it('keeps successful partial refs and bytes when the real store fails for another page', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('good.png', '/good'), page('bad.png', '/bad')];
    f.write('good.png', 'good');
    f.write('bad.png', 'bad');
    const write = f.store.write.bind(f.store);
    vi.spyOn(f.store, 'write').mockImplementation(async (...args) => {
      if (args[2].includes('bad')) throw new Error('disk error');
      return write(...args);
    });
    expect(await f.run()).toBe(true);
    expect(f.result.overall).toBe('pass');
    expect((await f.store.read(required(f.result.smoke.pages[0]?.screenshot))).toString()).toBe(
      'good',
    );
    expect(f.result.smoke.pages[1]?.screenshot).toBeUndefined();
    expect(f.log.warn).toHaveBeenCalledWith(
      { podId: 'activity-id', missingCount: 1, collectedCount: 1 },
      'Validation page screenshots were reported but not collected',
    );
    expect(f.log.warn.mock.calls.some((call) => call[1] === 'Failed to collect screenshots')).toBe(
      false,
    );
  });

  it('swallows real per-file fact store failures in both passes', async () => {
    const f = fixture();
    f.facts(fact('browser'));
    f.write('browser.png');
    vi.spyOn(f.store, 'write').mockRejectedValue(new Error('disk'));
    expect(await f.run()).toBe(true);
    expect(f.attachment().screenshot).toBeUndefined();
    expect(f.log.warn).not.toHaveBeenCalled();
    expect(f.log.info).toHaveBeenCalledWith(
      { podId: 'activity-id', count: 0 },
      'Collected host fact screenshots',
    );
    expect(f.log.info).toHaveBeenCalledWith(
      { podId: 'activity-id', count: 0 },
      'Collected fact screenshots',
    );
  });

  it.each(['host', 'smoke', 'fact'] as const)(
    'retains partial refs when %s success logging throws',
    async (stage) => {
      const f = fixture();
      f.facts(fact('browser'));
      f.write('browser.png');
      f.result.smoke.pages = [page('page.png')];
      f.write('page.png');
      const labels = {
        host: 'Collected host fact screenshots',
        smoke: 'Collected validation screenshots',
        fact: 'Collected fact screenshots',
      };
      const error = new Error(stage);
      f.log.info.mockImplementation((_data, message) => {
        if (message === labels[stage]) throw error;
      });
      expect(await f.run()).toBe(true);
      expect(f.attachment().screenshot).toBeDefined();
      expect(f.result.smoke.pages[0]?.screenshot).toBeDefined();
      expect(f.log.warn.mock.calls.some((c) => c[0]?.err === error)).toBe(true);
    },
  );

  it.each(['host', 'sync-start', 'smoke', 'fact'] as const)(
    'propagates %s activity thrown outside its try',
    async (stage) => {
      const f = fixture();
      f.facts(fact('browser'));
      f.write('browser.png');
      f.result.smoke.pages = [page('page.png')];
      f.write('page.png');
      const labels = {
        host: 'Collecting host fact evidence…',
        'sync-start': 'Syncing post-validation workspace…',
        smoke: 'Collecting validation screenshots…',
        fact: 'Collecting synced fact evidence…',
      };
      const original = required(vi.mocked(f.deps.emitActivityStatus).getMockImplementation());
      const error = new Error(stage);
      vi.mocked(f.deps.emitActivityStatus).mockImplementation((id, message) => {
        if (message === labels[stage]) throw error;
        original(id, message);
      });
      await expect(f.run()).rejects.toBe(error);
      expect(f.deps.syncWorkspaceBack).toHaveBeenCalledTimes(
        stage === 'host' || stage === 'sync-start' ? 0 : 1,
      );
      if (stage === 'fact') expect(f.result.smoke.pages[0]?.screenshot).toBeDefined();
    },
  );

  it.each(['success-activity', 'success-format'] as const)(
    'treats %s failure inside sync try as degraded',
    async (stage) => {
      const f = fixture();
      const error = new Error(stage);
      if (stage === 'success-format')
        vi.mocked(f.deps.formatElapsedDuration).mockImplementationOnce(() => {
          throw error;
        });
      else {
        const original = required(vi.mocked(f.deps.emitActivityStatus).getMockImplementation());
        vi.mocked(f.deps.emitActivityStatus).mockImplementation((id, message) => {
          if (message.startsWith('Workspace sync complete')) throw error;
          original(id, message);
        });
      }
      expect(await f.run()).toBe(false);
      expect(f.log.warn).toHaveBeenCalledWith(
        { err: error, podId: 'activity-id' },
        'Failed to sync workspace after validation',
      );
      expect(f.messages.some((m) => m.includes('continuing with degraded safeguards'))).toBe(true);
    },
  );

  it.each(['warn', 'degraded-activity', 'degraded-format'] as const)(
    'propagates %s failure from the sync catch',
    async (stage) => {
      const f = fixture();
      f.facts(fact('unit', 'unit-test'));
      const error = new Error(stage);
      vi.mocked(f.deps.syncWorkspaceBack).mockRejectedValue(new Error('sync'));
      if (stage === 'warn')
        f.log.warn.mockImplementation(() => {
          throw error;
        });
      if (stage === 'degraded-format')
        vi.mocked(f.deps.formatElapsedDuration).mockImplementation(() => {
          throw error;
        });
      if (stage === 'degraded-activity') {
        const original = required(vi.mocked(f.deps.emitActivityStatus).getMockImplementation());
        vi.mocked(f.deps.emitActivityStatus).mockImplementation((id, message) => {
          if (message.startsWith('Workspace sync failed')) throw error;
          original(id, message);
        });
      }
      await expect(f.run()).rejects.toBe(error);
      expect(f.messages).not.toContain('Collecting available fact evidence after degraded sync…');
    },
  );

  it('catches a missing-count warning failure, retaining collected refs', async () => {
    const f = fixture();
    f.result.smoke.pages = [page('good.png', '/good'), page('missing.png', '/missing')];
    f.write('good.png');
    const error = new Error('missing warning');
    f.log.warn.mockImplementationOnce(() => {
      throw error;
    });
    expect(await f.run()).toBe(true);
    expect(f.result.smoke.pages[0]?.screenshot).toBeDefined();
    expect(f.log.warn).toHaveBeenLastCalledWith(
      { err: error, podId: 'activity-id' },
      'Failed to collect screenshots',
    );
  });

  it.each(['host', 'smoke', 'fact'] as const)(
    'propagates %s catch logging failure after a thrown collector',
    async (stage) => {
      const f = fixture();
      f.facts(fact('browser'));
      f.result.smoke.pages = [page('page.png')];
      const original = collectors.collectFactScreenshots;
      if (stage === 'smoke')
        vi.spyOn(collectors, 'collectScreenshots').mockRejectedValue(new Error('collector'));
      else {
        const spy = vi.spyOn(collectors, 'collectFactScreenshots');
        if (stage === 'fact') spy.mockImplementationOnce(original);
        spy.mockRejectedValueOnce(new Error('collector'));
      }
      const error = new Error('warning');
      f.log.warn.mockImplementation((_data, message) => {
        if (message !== 'Validation page screenshots were reported but not collected') throw error;
      });
      await expect(f.run()).rejects.toBe(error);
    },
  );
});
