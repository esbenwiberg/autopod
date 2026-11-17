import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createSecretlintDetector } from '../security/detectors/secretlint-detector.js';
import { createAgentExecutionFixture } from '../test-utils/agent-execution-helpers.js';
import { operatorErrorMessage } from './completion-diagnostics.js';

describe('lifecycle regression runway', () => {
  it('scans the checked-in archive fixture and still detects and redacts credentials', async () => {
    const detector = createSecretlintDetector();
    const content = await readFile(
      new URL('./handled-elsewhere-archive.test.ts', import.meta.url),
      'utf8',
    );
    expect(
      await detector.scan({
        path: 'handled-elsewhere-archive.test.ts',
        content,
        sizeBytes: Buffer.byteLength(content),
      }),
    ).toEqual([]);
    const credential = ['https://user', 'secret@example.com/pr/1'].join(':');
    const findings = await detector.scan({
      path: 'input.txt',
      content: credential,
      sizeBytes: credential.length,
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(credential);
    expect(findings[0]?.snippet).toContain('[REDACTED]');
  });

  it('persists a validation diagnostic when checks-only completion throws', async () => {
    const f = createAgentExecutionFixture();
    try {
      f.podRepo.update('prepare', { skipAgent: true, recoveryWorktreePath: f.directory });
      f.processCaptured.operatorErrorMessage.mockImplementation(operatorErrorMessage);
      f.calls.triggerValidation.mockRejectedValueOnce(new Error('Synthetic scan failure'));
      await f.process().processPod.call(f.calls, 'prepare');
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(f.pod().status).toBe('failed');
      expect(f.pod().failureReason).toContain(
        'Pod failed during validation: Synthetic scan failure',
      );
    } finally {
      f.close();
    }
  });
});
