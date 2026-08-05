import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  SCREENSHOT_ARTIFACT_PATH,
  publishScreenshotArtifacts,
  screenshotArtifactBranch,
} from './screenshot-artifacts.js';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeDeps(
  pushArtifactBranch: WorktreeManager['pushArtifactBranch'] | undefined,
  logger = makeLogger(),
) {
  return {
    worktreeManager: { pushArtifactBranch } as unknown as WorktreeManager,
    logger,
    podId: 'abc12345',
    worktreePath: '/tmp/wt',
    pat: 'token',
  };
}

describe('screenshotArtifactBranch', () => {
  it('namespaces the ref per pod so a whole generation can be pruned at once', () => {
    expect(screenshotArtifactBranch('abc12345')).toBe('autopod/screenshots/abc12345');
  });
});

describe('publishScreenshotArtifacts', () => {
  it('pushes the screenshot dir to the artifact ref and returns the branch', async () => {
    const push = vi.fn().mockResolvedValue(true);
    const branch = await publishScreenshotArtifacts(makeDeps(push));

    expect(branch).toBe('autopod/screenshots/abc12345');
    expect(push).toHaveBeenCalledWith({
      worktreePath: '/tmp/wt',
      paths: [SCREENSHOT_ARTIFACT_PATH],
      branch: 'autopod/screenshots/abc12345',
      commitMessage: 'chore: validation screenshots for pod abc12345',
      pat: 'token',
    });
  });

  it('never targets the pod branch — the reviewed diff must stay agent-authored', async () => {
    const push = vi.fn().mockResolvedValue(true);
    await publishScreenshotArtifacts(makeDeps(push));
    expect(push.mock.calls[0]?.[0].branch).not.toBe('autopod/abc12345');
  });

  it('returns null when the push fails so the caller omits dead image links', async () => {
    const logger = makeLogger();
    const branch = await publishScreenshotArtifacts(
      makeDeps(vi.fn().mockResolvedValue(false), logger),
    );
    expect(branch).toBeNull();
    expect(logger.info).toHaveBeenCalled();
  });

  it('returns null when the worktree manager has no artifact-ref support', async () => {
    expect(await publishScreenshotArtifacts(makeDeps(undefined))).toBeNull();
  });
});
