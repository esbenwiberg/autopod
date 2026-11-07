import { describe, expect, it } from 'vitest';
import { createMockBridge } from '../test-utils/mock-bridge.js';
import { reportTaskSummary } from './report-task-summary.js';

describe('reportTaskSummary deferred checks', () => {
  it('independently rejects authority fields from direct callers', async () => {
    const bridge = createMockBridge();
    await expect(
      reportTaskSummary(
        'pod',
        {
          actualSummary: 'Done',
          deviations: [],
          deferredChecks: [
            {
              id: 'mac',
              check: 'xcodebuild test',
              reason: 'Linux',
              expectedExecutor: 'Mac',
              status: 'passed',
            } as never,
          ],
        },
        bridge,
      ),
    ).rejects.toThrow();
    expect(bridge.reportTaskSummary).not.toHaveBeenCalled();
  });

  it('leaves the legacy absent field absent and never manufactures a blocker', async () => {
    const bridge = createMockBridge();
    await reportTaskSummary('pod', { actualSummary: 'Done', deviations: [] }, bridge);
    expect(bridge.reportTaskSummary).toHaveBeenCalledWith(
      'pod',
      'Done',
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(bridge.createEscalation).not.toHaveBeenCalled();
  });
});
