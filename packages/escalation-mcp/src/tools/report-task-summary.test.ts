import { describe, expect, it, vi } from 'vitest';
import { createMockBridge } from '../test-utils/mock-bridge.js';
import { formatWorkspaceCleanlinessWarning, reportTaskSummary } from './report-task-summary.js';

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

describe('reportTaskSummary workspace cleanliness', () => {
  it('warns the live agent about exact leftovers, including locally excluded paths', async () => {
    const bridge = createMockBridge({
      inspectWorkspaceCleanliness: vi.fn(async () => ({
        untracked: ['notes.md'],
        changed: ['src/a.ts'],
        hiddenByLocalExclude: ['thoughts/'],
      })),
    });
    const text = await reportTaskSummary('pod', { actualSummary: 'Done', deviations: [] }, bridge);
    expect(bridge.reportTaskSummary).toHaveBeenCalled();
    expect(text).toContain('Task summary registered.');
    expect(text).toContain('WARNING: your workspace still has paths outside committed source.');
    expect(text).toContain('Uncommitted changes to tracked paths:\n- src/a.ts');
    expect(text).toContain('Untracked paths:\n- notes.md');
    expect(text).toContain(".git/info/exclude (Autopod's host copy does not share it");
    expect(text).toContain('- thoughts/');
  });

  it('stays quiet when clean, not applicable or unavailable', async () => {
    for (const inspect of [
      vi.fn(async () => ({ untracked: [], changed: [], hiddenByLocalExclude: [] })),
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('container gone');
      }),
    ]) {
      const bridge = createMockBridge({ inspectWorkspaceCleanliness: inspect });
      const text = await reportTaskSummary(
        'pod',
        { actualSummary: 'Done', deviations: [] },
        bridge,
      );
      expect(text).not.toContain('WARNING');
    }
    expect(formatWorkspaceCleanlinessWarning(undefined)).toBe('');
  });

  it('bounds and sanitizes listed paths', () => {
    const text = formatWorkspaceCleanlinessWarning({
      untracked: Array.from({ length: 22 }, (_, i) => `tmp/f${i}\u0007`),
      changed: [],
      hiddenByLocalExclude: [],
    });
    expect(text).toContain('- tmp/f0?');
    expect(text).toContain('- …and 2 more');
    expect(text).not.toContain('\u0007');
  });
});
