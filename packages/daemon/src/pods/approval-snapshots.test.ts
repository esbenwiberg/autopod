import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalFixture } from '../test-utils/approval-helpers.js';
import { APPROVAL_SNAPSHOT_EXCLUDES } from './approval-policy.js';
const fixtures: ReturnType<typeof createApprovalFixture>[] = [];
function fixture(disk = false) {
  const f = createApprovalFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('approval workspace snapshots', () => {
  it('preserves a real private report snapshot and receipt before source publication and cleanup', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    f.validated();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementation(
      async (_container, _source, destination) => {
        writeFileSync(join(destination, 'report.txt'), 'Private synthetic report');
      },
    );
    await f.workflow().approveSession('prepare');
    const path = f.pod().artifactsPath;
    if (!path) throw new Error('Missing published snapshot');
    expect(readFileSync(join(path, 'report.txt'), 'utf8')).toBe('Private synthetic report');
    expect(existsSync(`${path}.receipt.json`)).toBe(true);
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledWith(
      'container-123',
      '/workspace',
      expect.any(String),
      APPROVAL_SNAPSHOT_EXCLUDES,
      expect.objectContaining({
        onExportStarted: expect.any(Function),
        assertCurrent: expect.any(Function),
      }),
    );
    expect(vi.mocked(f.cm.extractDirectoryFromContainer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.worktreeManager.mergeBranch).mock.invocationCallOrder[0] ?? 0,
    );
  });
  it('admits only one same-pod snapshot and merge across concurrent approvals', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    f.validated();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const collecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementation(
      async (_id, _src, destination, _exclude, options) => {
        options?.onExportStarted?.();
        started();
        await gate;
        writeFileSync(join(destination, 'report.txt'), 'complete');
      },
    );
    const workflow = f.workflow();
    const first = workflow.approveSession('prepare');
    await collecting;
    await expect(workflow.approveSession('prepare')).rejects.toMatchObject({
      code: 'APPROVAL_IN_PROGRESS',
    });
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
    finish();
    await first;
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalledOnce();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).toHaveBeenCalledOnce();
  });
  it('rejects stale ownership during wakeup without export publication or cleanup', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    f.validated();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementation(
      async (_id, _src, _target, _exclude, options) => {
        f.podRepo.incrementLifecycleGeneration('prepare');
        options?.onExportStarted?.();
      },
    );
    await expect(f.workflow().approveSession('prepare')).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    expect(f.pod().artifactsPath).toBeNull();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });
  it('retains the original source/container and wrapped extraction error on snapshot failure', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    f.validated();
    const failure = new Error('Synthetic copy failure');
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValueOnce(failure);
    await expect(f.workflow().approveSession('prepare')).rejects.toMatchObject({
      code: 'ARTIFACT_PRESERVATION_FAILED',
      cause: failure,
    });
    expect(f.pod()).toMatchObject({
      status: 'validated',
      containerId: 'container-123',
      artifactsPath: null,
    });
    expect(f.pod().failureReason).toContain('Retained sandbox wakeup failed');
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });
});
