import { AutopodError } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RepoScanResult, RepoScanner } from '../security/index.js';
import { createScanRepository } from '../security/scan-repository.js';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { createDeliveryScan } from './delivery-scan.js';
function scannerFixture() {
  const f = createDeliveryFixture();
  const result: RepoScanResult = {
    podId: 'prepare',
    checkpoint: 'push',
    startedAt: 1,
    completedAt: 2,
    filesScanned: 1,
    filesSkipped: 0,
    scanIncomplete: false,
    findings: [],
    decision: 'pass',
    warningSection: null,
  };
  const scan = vi.fn<RepoScanner['scan']>(async () => result);
  const captured = {
    repoScanner: { scan },
    scanRepo: createScanRepository(f.db),
    logger: f.deps.logger,
    emitActivityStatus: vi.fn(),
    emitBlockingSecurityScanFindings: vi.fn(),
  };
  return {
    ...f,
    result,
    scan,
    scanCaptured: captured,
    scanOwner: () => createDeliveryScan(captured),
  };
}
describe('push checkpoint scans', () => {
  it('uses the original base/workspace context and skips absent worktrees', async () => {
    const f = scannerFixture();
    await f
      .scanOwner()
      .runPushCheckpointScan({ ...f.pod(), worktreePath: null }, f.passContext().profile);
    expect(f.scan).not.toHaveBeenCalled();
    await f
      .scanOwner()
      .runPushCheckpointScan({ ...f.pod(), baseBranch: 'release' }, f.passContext().profile);
    expect(f.scan).toHaveBeenCalledWith(
      'push',
      expect.objectContaining({
        podId: 'prepare',
        baseRef: 'origin/release',
        workdir: f.directory,
        isWorkspacePod: false,
      }),
    );
  });
  it('retains a blocking scan error and fail-open behavior only for non-Autopod errors', async () => {
    const f = scannerFixture();
    f.result.decision = 'block';
    await expect(
      f.scanOwner().runPushCheckpointScan(f.pod(), f.passContext().profile),
    ).rejects.toMatchObject({ code: 'SECURITY_SCAN_BLOCKED' });
    expect(f.scanCaptured.emitBlockingSecurityScanFindings).toHaveBeenCalledWith('prepare', []);
    f.scan.mockRejectedValueOnce(new Error('synthetic scanner outage'));
    await expect(
      f.scanOwner().runPushCheckpointScan(f.pod(), f.passContext().profile),
    ).resolves.toBeUndefined();
    const failure = new AutopodError('synthetic typed failure', 'SCAN_TYPED_FAILURE', 409);
    f.scan.mockRejectedValueOnce(failure);
    await expect(
      f.scanOwner().runPushCheckpointScan(f.pod(), f.passContext().profile),
    ).rejects.toBe(failure);
  });
  it('allows an escalate decision and reads the latest persisted push findings', async () => {
    const f = scannerFixture();
    f.result.decision = 'escalate';
    await expect(
      f.scanOwner().runPushCheckpointScan(f.pod(), f.passContext().profile),
    ).resolves.toBeUndefined();
    const finding = {
      detector: 'secrets' as const,
      severity: 'high' as const,
      file: 'synthetic.txt',
      snippet: 'redacted',
    };
    f.scanCaptured.scanRepo.insert({ ...f.result, findings: [finding] });
    f.scanCaptured.scanRepo.insert({ ...f.result, checkpoint: 'provisioning' });
    expect(f.scanOwner().getLatestPushFindings('prepare')).toEqual([finding]);
    vi.spyOn(f.scanCaptured.scanRepo, 'getForPod').mockImplementationOnce(() => {
      throw new Error('synthetic read');
    });
    expect(f.scanOwner().getLatestPushFindings('prepare')).toEqual([]);
  });
});
