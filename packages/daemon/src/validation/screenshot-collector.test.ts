import fsp from 'node:fs/promises';
import type { PageResult, ScreenshotRef } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGitHubImageUrl, collectScreenshots } from './screenshot-collector.js';

vi.mock('node:fs/promises');
const mockedFs = vi.mocked(fsp);

function makeMockStore() {
  return {
    write: vi.fn().mockImplementation(
      (podId: string, source: string, filename: string): Promise<ScreenshotRef> =>
        Promise.resolve({
          podId,
          source: source as ScreenshotRef['source'],
          filename,
          relativePath: `screenshots/${podId}/${source}/${filename}`,
        }),
    ),
    read: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  };
}

describe('collectScreenshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads PNGs from the host worktree and returns ScreenshotRefs', async () => {
    const pngBuffer = Buffer.from('fake-png-data');
    mockedFs.readFile.mockResolvedValue(pngBuffer);

    const pages: PageResult[] = [
      {
        path: '/',
        status: 'pass',
        screenshotPath: '/workspace/.autopod/screenshots/root.png',
        consoleErrors: [],
        assertions: [],
        loadTime: 100,
      },
    ];

    const store = makeMockStore();
    const result = await collectScreenshots('/tmp/worktree/abc', pages, store, 'pod-1');

    expect(result).toHaveLength(1);
    expect(result[0]?.pagePath).toBe('/');
    expect(result[0]?.ref.source).toBe('smoke');
    expect(result[0]?.ref.podId).toBe('pod-1');
    expect(result[0]?.ref.filename).toBe('0-root.png');

    expect(mockedFs.readFile).toHaveBeenCalledWith(
      '/tmp/worktree/abc/.autopod/screenshots/root.png',
    );
    expect(store.write).toHaveBeenCalledWith('pod-1', 'smoke', '0-root.png', pngBuffer);
  });

  it('skips pages without screenshotPath', async () => {
    const pages: PageResult[] = [
      {
        path: '/',
        status: 'fail',
        screenshotPath: '',
        consoleErrors: ['error'],
        assertions: [],
        loadTime: 0,
      },
    ];

    const store = makeMockStore();
    const result = await collectScreenshots('/tmp/worktree/abc', pages, store, 'pod-1');
    expect(result).toHaveLength(0);
    expect(mockedFs.readFile).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('skips missing files gracefully', async () => {
    mockedFs.readFile.mockRejectedValue(new Error('ENOENT'));

    const pages: PageResult[] = [
      {
        path: '/missing',
        status: 'pass',
        screenshotPath: '/workspace/.autopod/screenshots/missing.png',
        consoleErrors: [],
        assertions: [],
        loadTime: 100,
      },
    ];

    const store = makeMockStore();
    const result = await collectScreenshots('/tmp/worktree/abc', pages, store, 'pod-1');
    expect(result).toHaveLength(0); // Skipped, no error thrown
    expect(store.write).not.toHaveBeenCalled();
  });

  it('handles multiple pages and uses index-based filenames', async () => {
    mockedFs.readFile.mockResolvedValue(Buffer.from('png'));

    const pages: PageResult[] = [
      {
        path: '/',
        status: 'pass',
        screenshotPath: '/workspace/.autopod/screenshots/root.png',
        consoleErrors: [],
        assertions: [],
        loadTime: 100,
      },
      {
        path: '/about',
        status: 'pass',
        screenshotPath: '/workspace/.autopod/screenshots/about.png',
        consoleErrors: [],
        assertions: [],
        loadTime: 100,
      },
    ];

    const store = makeMockStore();
    const result = await collectScreenshots('/tmp/wt', pages, store, 'pod-1');
    expect(result).toHaveLength(2);
    expect(result[0]?.pagePath).toBe('/');
    expect(result[1]?.pagePath).toBe('/about');
    // Index prefix ensures disambiguation
    expect(result[0]?.ref.filename).toBe('0-root.png');
    expect(result[1]?.ref.filename).toBe('1-about.png');
  });
});

describe('buildGitHubImageUrl', () => {
  it('constructs raw URL from HTTPS repo URL', () => {
    const url = buildGitHubImageUrl(
      'https://github.com/org/repo',
      'autopod/abc123',
      '.autopod/screenshots/root.png',
    );
    expect(url).toBe(
      'https://github.com/org/repo/blob/autopod/abc123/.autopod/screenshots/root.png?raw=true',
    );
  });

  it('strips .git suffix', () => {
    const url = buildGitHubImageUrl(
      'https://github.com/org/repo.git',
      'feature/test',
      '.autopod/screenshots/about.png',
    );
    expect(url).toBe(
      'https://github.com/org/repo/blob/feature/test/.autopod/screenshots/about.png?raw=true',
    );
  });
});
