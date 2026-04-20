import fs from 'node:fs';
import path from 'node:path';
import { ProfileExistsError, ProfileNotFoundError } from '@autopod/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ProfileStore, createProfileStore } from './profile-store.js';

const migrationsDir = path.resolve(import.meta.dirname, '../db/migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        db.exec(`${stmt};`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('duplicate column name')) throw err;
      }
    }
  }
  return db;
}

const validInput = {
  name: 'my-app',
  repoUrl: 'https://github.com/org/repo',
  buildCommand: 'npm run build',
  startCommand: 'node server.js --port $PORT',
};

describe('ProfileStore', () => {
  let db: Database.Database;
  let store: ProfileStore;

  beforeEach(() => {
    db = createTestDb();
    store = createProfileStore(db);
  });

  describe('create', () => {
    it('should create a profile and read it back', () => {
      const profile = store.create(validInput);
      expect(profile.name).toBe('my-app');
      expect(profile.repoUrl).toBe('https://github.com/org/repo');
      expect(profile.buildCommand).toBe('npm run build');
      expect(profile.startCommand).toBe('node server.js --port $PORT');
    });

    it('should apply defaults for optional fields', () => {
      const profile = store.create(validInput);
      expect(profile.defaultBranch).toBe('main');
      expect(profile.template).toBe('node22');
      expect(profile.healthPath).toBe('/');
      expect(profile.healthTimeout).toBe(120);
      expect(profile.maxValidationAttempts).toBe(3);
      expect(profile.defaultModel).toBe('opus');
      expect(profile.defaultRuntime).toBe('claude');
      expect(profile.customInstructions).toBeNull();
      expect(profile.extends).toBeNull();
      expect(profile.branchPrefix).toBe('autopod/');
      expect(profile.smokePages).toEqual([]);
      expect(profile.escalation).toEqual({
        askHuman: true,
        askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: false },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      });
    });

    it('should create with all fields specified', () => {
      const profile = store.create({
        ...validInput,
        defaultBranch: 'develop',
        branchPrefix: 'feature/',
        template: 'node22-pw',
        healthPath: '/health',
        healthTimeout: 60,
        smokePages: [{ path: '/', assertions: [{ selector: 'h1', type: 'exists' }] }],
        maxValidationAttempts: 5,
        defaultModel: 'sonnet',
        defaultRuntime: 'claude',
        customInstructions: 'Be careful',
        escalation: {
          askHuman: false,
          askAi: { enabled: true, model: 'opus', maxCalls: 10 },
          autoPauseAfter: 5,
          humanResponseTimeout: 7200,
        },
      });
      expect(profile.defaultBranch).toBe('develop');
      expect(profile.branchPrefix).toBe('feature/');
      expect(profile.template).toBe('node22-pw');
      expect(profile.healthPath).toBe('/health');
      expect(profile.healthTimeout).toBe(60);
      expect(profile.smokePages).toHaveLength(1);
      expect(profile.smokePages[0]?.assertions).toHaveLength(1);
      expect(profile.maxValidationAttempts).toBe(5);
      expect(profile.defaultModel).toBe('sonnet');
      expect(profile.customInstructions).toBe('Be careful');
      expect(profile.escalation.askHuman).toBe(false);
      expect(profile.escalation.askAi.enabled).toBe(true);
    });

    it('should throw ProfileExistsError on duplicate name', () => {
      store.create(validInput);
      expect(() => store.create(validInput)).toThrow(ProfileExistsError);
    });

    it('should throw ProfileNotFoundError if extends references nonexistent parent', () => {
      expect(() => store.create({ ...validInput, extends: 'nonexistent' })).toThrow(
        ProfileNotFoundError,
      );
    });
  });

  describe('get', () => {
    it('should throw ProfileNotFoundError for nonexistent profile', () => {
      expect(() => store.get('nonexistent')).toThrow(ProfileNotFoundError);
    });

    it('should return resolved profile with inheritance applied', () => {
      store.create({ ...validInput, name: 'parent', customInstructions: 'parent rules' });
      store.create({
        ...validInput,
        name: 'child',
        extends: 'parent',
        customInstructions: 'child rules',
      });

      const resolved = store.get('child');
      expect(resolved.customInstructions).toBe('parent rules\n\nchild rules');
    });
  });

  describe('getRaw', () => {
    it('should return unresolved profile (no inheritance applied)', () => {
      store.create({
        ...validInput,
        name: 'parent',
        smokePages: [{ path: '/parent' }],
      });
      store.create({
        ...validInput,
        name: 'child',
        extends: 'parent',
        smokePages: [{ path: '/child' }],
      });

      const raw = store.getRaw('child');
      expect(raw.smokePages).toEqual([{ path: '/child' }]);
      expect(raw.extends).toBe('parent');
    });
  });

  describe('list', () => {
    it('should return all profiles', () => {
      store.create({ ...validInput, name: 'app-a' });
      store.create({ ...validInput, name: 'app-b' });

      const profiles = store.list();
      expect(profiles).toHaveLength(2);
      expect(profiles[0]?.name).toBe('app-a');
      expect(profiles[1]?.name).toBe('app-b');
    });

    it('should return profiles with inheritance resolved', () => {
      store.create({
        ...validInput,
        name: 'parent',
        customInstructions: 'base',
      });
      store.create({
        ...validInput,
        name: 'child',
        extends: 'parent',
        customInstructions: 'extra',
      });

      const profiles = store.list();
      const child = profiles.find((p) => p.name === 'child');
      expect(child?.customInstructions).toBe('base\n\nextra');
    });
  });

  describe('update', () => {
    it('should update specific fields only', () => {
      store.create(validInput);
      const updated = store.update('my-app', { buildCommand: 'pnpm build' });
      expect(updated.buildCommand).toBe('pnpm build');
      expect(updated.startCommand).toBe('node server.js --port $PORT');
    });

    it('should update updatedAt timestamp', () => {
      store.create(validInput);
      // Read raw to get the DB-assigned createdAt
      store.getRaw('my-app').updatedAt;
      // Force a different timestamp by manipulating the DB directly
      db.prepare(
        "UPDATE profiles SET updated_at = '2020-01-01T00:00:00.000Z' WHERE name = 'my-app'",
      ).run();
      const updated = store.update('my-app', { buildCommand: 'pnpm build' });
      expect(updated.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('should throw ProfileNotFoundError for nonexistent profile', () => {
      expect(() => store.update('nonexistent', { buildCommand: 'x' })).toThrow(
        ProfileNotFoundError,
      );
    });

    it('should not touch untouched fields', () => {
      store.create({
        ...validInput,
        customInstructions: 'keep this',
        healthTimeout: 200,
      });
      const updated = store.update('my-app', { buildCommand: 'pnpm build' });
      expect(updated.customInstructions).toBe('keep this');
      expect(updated.healthTimeout).toBe(200);
    });

    it('should verify new parent exists when changing extends', () => {
      store.create(validInput);
      expect(() => store.update('my-app', { extends: 'nonexistent' })).toThrow(
        ProfileNotFoundError,
      );
    });

    it('should return unchanged profile when no changes provided', () => {
      store.create(validInput);
      const result = store.update('my-app', {});
      expect(result.name).toBe('my-app');
    });
  });

  describe('delete', () => {
    it('should remove the profile', () => {
      store.create(validInput);
      store.delete('my-app');
      expect(store.exists('my-app')).toBe(false);
    });

    it('should throw ProfileNotFoundError for nonexistent', () => {
      expect(() => store.delete('nonexistent')).toThrow(ProfileNotFoundError);
    });

    it('should throw when active pods reference the profile', () => {
      store.create(validInput);

      // Insert a pod in running state referencing this profile
      db.prepare(`
        INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
        VALUES ('sess1', 'my-app', 'do stuff', 'running', 'opus', 'claude', 'main', 'user1')
      `).run();

      expect(() => store.delete('my-app')).toThrow('active pods');
    });

    it('should allow delete when pods are complete or killed', () => {
      store.create(validInput);

      db.prepare(`
        INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
        VALUES ('sess1', 'my-app', 'do stuff', 'complete', 'opus', 'claude', 'main', 'user1')
      `).run();

      // completed pods should be auto-cleaned and not block deletion
      expect(() => store.delete('my-app')).not.toThrow();
      expect(store.exists('my-app')).toBe(false);
    });

    it('should throw when other profiles extend this one', () => {
      store.create({ ...validInput, name: 'parent' });
      store.create({ ...validInput, name: 'child', extends: 'parent' });

      expect(() => store.delete('parent')).toThrow('extended by');
    });
  });

  describe('exists', () => {
    it('should return true for existing profile', () => {
      store.create(validInput);
      expect(store.exists('my-app')).toBe(true);
    });

    it('should return false for nonexistent profile', () => {
      expect(store.exists('nope')).toBe(false);
    });
  });

  describe('JSON roundtrip', () => {
    it('should preserve smokePages through create/get', () => {
      const pages = [
        { path: '/', assertions: [{ selector: '#app', type: 'exists' as const }] },
        {
          path: '/about',
          assertions: [{ selector: 'h1', type: 'text_contains' as const, value: 'About' }],
        },
      ];
      store.create({ ...validInput, smokePages: pages });
      const profile = store.get('my-app');
      expect(profile.smokePages).toEqual(pages);
    });

    it('should preserve escalation config through create/get', () => {
      const escalation = {
        askHuman: false,
        askAi: { enabled: true, model: 'opus', maxCalls: 10 },
        advisor: { enabled: false },
        autoPauseAfter: 5,
        humanResponseTimeout: 7200,
      };
      store.create({ ...validInput, escalation });
      const profile = store.get('my-app');
      expect(profile.escalation).toEqual(escalation);
    });

    it('should preserve privateRegistries through create/get', () => {
      const registries = [
        {
          type: 'npm' as const,
          url: 'https://pkgs.dev.azure.com/myorg/_packaging/feed/npm/registry/',
          scope: '@myorg',
        },
        {
          type: 'nuget' as const,
          url: 'https://pkgs.dev.azure.com/myorg/_packaging/feed/nuget/v3/index.json',
        },
      ];
      store.create({ ...validInput, privateRegistries: registries });
      const profile = store.get('my-app');
      expect(profile.privateRegistries).toEqual(registries);
    });

    it('should preserve registryPat through create/get', () => {
      store.create({ ...validInput, registryPat: 'my-secret-pat' });
      const profile = store.get('my-app');
      expect(profile.registryPat).toBe('my-secret-pat');
    });

    it('should default privateRegistries to empty array', () => {
      store.create(validInput);
      const profile = store.get('my-app');
      expect(profile.privateRegistries).toEqual([]);
    });

    it('should default registryPat to null', () => {
      store.create(validInput);
      const profile = store.get('my-app');
      expect(profile.registryPat).toBeNull();
    });

    it('should update privateRegistries and registryPat', () => {
      store.create(validInput);
      const registries = [
        {
          type: 'npm' as const,
          url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/',
        },
      ];
      const updated = store.update('my-app', {
        privateRegistries: registries,
        registryPat: 'updated-pat',
      });
      expect(updated.privateRegistries).toEqual(registries);
      expect(updated.registryPat).toBe('updated-pat');
    });
  });

  describe('multi-level inheritance', () => {
    it('should resolve A extends B extends C', () => {
      store.create({
        ...validInput,
        name: 'grandparent',
        customInstructions: 'gp rules',
        smokePages: [{ path: '/gp' }],
      });
      store.create({
        ...validInput,
        name: 'parent',
        extends: 'grandparent',
        customInstructions: 'parent rules',
        smokePages: [{ path: '/parent' }],
      });
      store.create({
        ...validInput,
        name: 'child',
        extends: 'parent',
        customInstructions: 'child rules',
        smokePages: [{ path: '/child' }],
      });

      const resolved = store.get('child');
      expect(resolved.customInstructions).toBe('gp rules\n\nparent rules\n\nchild rules');
      expect(resolved.smokePages).toEqual([
        { path: '/gp' },
        { path: '/parent' },
        { path: '/child' },
      ]);
    });
  });

  describe('resolveCredentialOwner', () => {
    it('returns the profile itself when it owns credentials', () => {
      store.create({
        ...validInput,
        name: 'owner',
        modelProvider: 'max',
        providerCredentials: {
          provider: 'max',
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: '2026-12-31T00:00:00Z',
        },
      });
      expect(store.resolveCredentialOwner('owner')).toBe('owner');
    });

    it('returns null when nobody in the chain has credentials', () => {
      store.create({ ...validInput, name: 'parent' });
      store.create({ ...validInput, name: 'child', extends: 'parent' });
      expect(store.resolveCredentialOwner('child')).toBeNull();
    });

    it('walks up the extends chain to find the credential owner', () => {
      store.create({
        ...validInput,
        name: 'base',
        modelProvider: 'max',
        providerCredentials: {
          provider: 'max',
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: '2026-12-31T00:00:00Z',
        },
      });
      store.create({ ...validInput, name: 'middle', extends: 'base' });
      store.create({ ...validInput, name: 'leaf', extends: 'middle' });
      expect(store.resolveCredentialOwner('leaf')).toBe('base');
    });

    it('stops at the first non-null credential in the chain', () => {
      store.create({
        ...validInput,
        name: 'base',
        modelProvider: 'max',
        providerCredentials: {
          provider: 'max',
          accessToken: 'base-a',
          refreshToken: 'base-r',
          expiresAt: '2026-12-31T00:00:00Z',
        },
      });
      store.create({
        ...validInput,
        name: 'middle',
        extends: 'base',
        providerCredentials: {
          provider: 'max',
          accessToken: 'mid-a',
          refreshToken: 'mid-r',
          expiresAt: '2026-12-31T00:00:00Z',
        },
      });
      store.create({ ...validInput, name: 'leaf', extends: 'middle' });
      expect(store.resolveCredentialOwner('leaf')).toBe('middle');
    });
  });
});
