import { describe, expect, it } from 'vitest';
import { MergeQueue } from './merge-queue.js';

describe('MergeQueue.keyFor', () => {
  it('combines repo URL and base branch', () => {
    expect(MergeQueue.keyFor('https://github.com/o/r', 'main')).toBe(
      'https://github.com/o/r::main',
    );
  });

  it('uses a stable placeholder when repoUrl is null', () => {
    expect(MergeQueue.keyFor(null, 'main')).toBe('<no-repo>::main');
  });

  it('treats different base branches as distinct keys', () => {
    expect(MergeQueue.keyFor('repo', 'main')).not.toBe(MergeQueue.keyFor('repo', 'develop'));
  });

  it('treats different repos as distinct keys', () => {
    expect(MergeQueue.keyFor('repo-a', 'main')).not.toBe(MergeQueue.keyFor('repo-b', 'main'));
  });
});
