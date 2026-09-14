import { describe, expect, it } from 'vitest';
import { createMemoryRepository } from '../pods/memory-repository.js';
import { memoryMatchesProjectSetup } from '../pods/project-memory-scope.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import {
  applyLegacyMemoryMigration,
  previewLegacyMemoryMigration,
} from './legacy-memory-migration.js';
import type { LegacyMigrationManifest } from './legacy-profile-migration.js';

function fixture() {
  const db = createTestDb();
  const { store } = createTestConfiguration(db);
  const repository = store.get('repository', 'repo-a');
  store.write({
    ...repository,
    expectedRevision: repository.revision,
    payload: {
      ...repository.payload,
      setups: [
        ...repository.payload.setups,
        { ...repository.payload.setups[0]!, id: 'other', name: 'Other' },
      ],
    },
  });
  const binding = (
    name: string,
    repo: string | null,
    setup: string | null,
  ): LegacyMigrationManifest['bindings'][number] => ({
    legacyProfileName: name,
    legacyVersion: 1,
    repositoryId: repo,
    setupId: setup,
    profileId: 'profile',
    watcher: { enabled: false, labelPrefix: '' },
    memoryScope: { repositoryId: repo, setupId: setup, legacyProfileName: name },
    legacyCache: { tag: null, builtAt: null },
  });
  const manifest: LegacyMigrationManifest = {
    schemaVersion: 1,
    sourceDigest: 'a'.repeat(64),
    entities: [],
    blockers: [],
    warnings: [],
    bindings: [
      binding('one', 'repo-a', 'default'),
      binding('two', 'repo-a', 'other'),
      binding('three', 'repo-b', 'default'),
      binding('scratch', null, null),
    ],
  };
  const insert = (id: string, profile: string) =>
    db
      .prepare(
        "INSERT INTO memory_entries(id,scope,scope_id,path,content,content_sha256,version,approved) VALUES(?,'profile',?,'/setup.md',?,'fixture-digest',7,1)",
      )
      .run(id, profile, `PRIVATE fixture content ${id}`);
  for (const name of ['one', 'two', 'three', 'scratch']) insert(name, name);
  return { db, manifest, insert };
}

describe('legacy memory conversion', () => {
  it('preserves repository/setup affinity, provenance and restricted unmapped memory with idempotent replay', () => {
    const f = fixture();
    try {
      const preview = previewLegacyMemoryMigration(f.db, f.manifest);
      expect(preview.conflicts).toEqual([]);
      expect(preview.mappings).toHaveLength(3);
      expect(preview.retained.map((item) => item.id)).toEqual(['scratch']);
      expect(JSON.stringify(preview)).not.toContain('PRIVATE');
      const before = f.db.prepare("SELECT * FROM memory_entries WHERE id='one'").get() as Record<
        string,
        unknown
      >;
      expect(applyLegacyMemoryMigration(f.db, f.manifest, preview.digest).applied).toBe(true);
      const after = f.db.prepare("SELECT * FROM memory_entries WHERE id='one'").get();
      expect(after).toEqual({
        ...before,
        scope: 'repository',
        scope_id: 'repo-a',
        repository_setup_id: 'default',
      });
      const memories = createMemoryRepository(f.db);
      const inSetup = (setupId: string) =>
        memories
          .list('repository', 'repo-a', true)
          .filter((entry) =>
            memoryMatchesProjectSetup(entry, { scope: 'repository', id: 'repo-a', setupId }),
          )
          .map((entry) => entry.id);
      expect(inSetup('default')).toEqual(['one']);
      expect(inSetup('other')).toEqual(['two']);
      expect(memories.list('repository', 'repo-b', true).map((entry) => entry.id)).toEqual([
        'three',
      ]);
      expect(memories.getOrThrow('scratch').scope).toBe('profile');
      expect(applyLegacyMemoryMigration(f.db, f.manifest, preview.digest).applied).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it('refuses changed source rows and collisions without partially moving memories', () => {
    const f = fixture();
    try {
      const preview = previewLegacyMemoryMigration(f.db, f.manifest);
      f.db.prepare("UPDATE memory_entries SET content='Changed after review' WHERE id='one'").run();
      expect(() => applyLegacyMemoryMigration(f.db, f.manifest, preview.digest)).toThrow(
        'source changed',
      );
      f.insert('duplicate', 'one');
      const conflicting = previewLegacyMemoryMigration(f.db, f.manifest);
      expect(conflicting.conflicts).toHaveLength(1);
      expect(() => applyLegacyMemoryMigration(f.db, f.manifest, conflicting.digest)).toThrow(
        'conflicting memory paths',
      );
      expect(
        f.db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE scope='repository'").get(),
      ).toEqual({ n: 0 });
    } finally {
      f.db.close();
    }
  });
});
