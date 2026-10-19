import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertConfigurationTestPod } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createProgressEventRepository } from './progress-event-repository.js';

vi.mock('@autopod/shared', async (original) => ({
  ...(await original<typeof import('@autopod/shared')>()),
  generatePodId: () => 'busy-emu',
}));

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('progress event identities', () => {
  it('retains every update even when the friendly pod-name generator repeats', () => {
    const db = createTestDb();
    databases.push(db);
    insertConfigurationTestPod(db, 'first');
    insertConfigurationTestPod(db, 'second');
    const repo = createProgressEventRepository(db);
    repo.insert('first', 'research', 'Read code', 1, 3);
    repo.insert('first', 'test', 'Run tests', 2, 3);
    repo.insert('second', 'research', 'Read another repository', 1, 2);
    const first = repo.listBySession('first');
    const second = repo.listBySession('second');
    expect(first.map((row) => row.description)).toEqual(['Read code', 'Run tests']);
    expect(second.map((row) => row.description)).toEqual(['Read another repository']);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3);
  });
});
