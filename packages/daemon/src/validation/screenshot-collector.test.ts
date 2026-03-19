import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { collectScreenshots, buildGitHubImageUrl } from './screenshot-collector.js';
import type { PageResult } from '@autopod/shared';

vi.mock('node:fs/promises');
const mockedFs = vi.mocked(fs);

describe('collectScreenshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads PNGs from the host worktree and returns base64', async () => {
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

    const result = await collectScreenshots('/tmp/worktree/abc', pages);

    expect(result).toHaveLength(1);
    expect(result[0]!.pagePath).toBe('/');
    expect(result[0]!.relativePath).toBe('.autopod/screenshots/root.png');
    expect(result[0]!.hostPath).toBe('/tmp/worktree/abc/.autopod/screenshots/root.png');
    expect(result[0]!.base64).toBe(pngBuffer.toString('base64'));

    expect(mockedFs.readFile).toHaveBeenCalledWith('/tmp/worktree/abc/.autopod/screenshots/root.png');
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

    const result = await collectScreenshots('/tmp/worktree/abc', pages);
    expect(result).toHaveLength(0);
    expect(mockedFs.readFile).not.toHaveBeenCalled();
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

    const result = await collectScreenshots('/tmp/worktree/abc', pages);
    expect(result).toHaveLength(0); // Skipped, no error thrown
  });

  it('handles multiple pages', async () => {
    mockedFs.readFile.mockResolvedValue(Buffer.from('png'));

    const pages: PageResult[] = [
      { path: '/', status: 'pass', screenshotPath: '/workspace/.autopod/screenshots/root.png', consoleErrors: [], assertions: [], loadTime: 100 },
      { path: '/about', status: 'pass', screenshotPath: '/workspace/.autopod/screenshots/about.png', consoleErrors: [], assertions: [], loadTime: 100 },
    ];

    const result = await collectScreenshots('/tmp/wt', pages);
    expect(result).toHaveLength(2);
    expect(result[0]!.pagePath).toBe('/');
    expect(result[1]!.pagePath).toBe('/about');
  });
});

describe('buildGitHubImageUrl', () => {
  it('constructs raw URL from HTTPS repo URL', () => {
    const url = buildGitHubImageUrl(
      'https://github.com/org/repo',
      'autopod/abc123',
      '.autopod/screenshots/root.png',
    );
    expect(url).toBe('https://github.com/org/repo/blob/autopod/abc123/.autopod/screenshots/root.png?raw=true');
  });

  it('strips .git suffix', () => {
    const url = buildGitHubImageUrl(
      'https://github.com/org/repo.git',
      'feature/test',
      '.autopod/screenshots/about.png',
    );
    expect(url).toBe('https://github.com/org/repo/blob/feature/test/.autopod/screenshots/about.png?raw=true');
  });
});
