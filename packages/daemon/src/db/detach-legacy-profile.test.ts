import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { detachLegacyPodProfile } from './detach-legacy-profile.js';

describe('detach legacy pod profile identity', () => {
  it('preserves rows, child references, views, indexes and history guards while admitting new profile IDs', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=OFF');
      db.exec(`CREATE TABLE profiles(name TEXT PRIMARY KEY);
        INSERT INTO profiles VALUES('legacy');
        CREATE TABLE pods(id TEXT PRIMARY KEY, profile_name TEXT NOT NULL REFERENCES profiles(name), payload TEXT, launch_config_digest TEXT);
        CREATE INDEX pod_profile ON pods(profile_name);
        CREATE TABLE child(pod_id TEXT REFERENCES pods(id), value TEXT);
        INSERT INTO pods VALUES('old','legacy','preserve exactly',NULL);
        INSERT INTO child VALUES('old','child evidence');
        CREATE VIEW retained_pods AS SELECT * FROM pods;
        CREATE TRIGGER no_delete BEFORE DELETE ON pods BEGIN SELECT RAISE(ABORT,'retain history'); END;`);
      const before = db.prepare('SELECT * FROM pods').all();
      db.transaction(() => detachLegacyPodProfile(db))();
      db.pragma('foreign_keys=ON');
      expect(db.prepare('SELECT * FROM retained_pods').all()).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare('SELECT * FROM child').all()).toEqual([
        { pod_id: 'old', value: 'child evidence' },
      ]);
      expect(db.pragma('index_list(pods)')).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'pod_profile' })]),
      );
      expect(() => db.exec("DELETE FROM pods WHERE id='old'")).toThrow('retain history');
      db.exec("INSERT INTO pods VALUES('new','composable-profile','new launch','digest')");
      expect(
        db.prepare("SELECT * FROM profiles WHERE name='composable-profile'").get(),
      ).toBeUndefined();
      expect(() => db.exec("INSERT INTO child VALUES('missing','invalid')")).toThrow('FOREIGN KEY');
    } finally {
      db.close();
    }
  });
  it('rolls back an unexpected schema without removing any authority or history constraint', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=OFF');
      db.exec('CREATE TABLE pods(id TEXT PRIMARY KEY, profile_name TEXT)');
      const before = db.prepare('SELECT * FROM sqlite_master').all();
      expect(() => db.transaction(() => detachLegacyPodProfile(db))()).toThrow('Unexpected legacy');
      expect(db.prepare('SELECT * FROM sqlite_master').all()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
