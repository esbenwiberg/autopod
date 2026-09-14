import { describe, expect, it } from 'vitest';
import { rowToProfile } from '../profiles/profile-store.js';
import { createScheduledJobRepository } from '../scheduled-jobs/scheduled-job-repository.js';
import {
  createTestDb,
  insertTestProfile,
  insertTestScheduledJob,
  logger,
} from '../test-utils/mock-helpers.js';
import {
  applyConfigurationConversion,
  previewConfigurationConversion,
} from './legacy-configuration-conversion.js';

describe('coordinated configuration conversion', () => {
  it('preserves watcher enablement and completed issue history while blocking unreconciled work', async () => {
    const { db, input } = fixture();
    try {
      db.prepare(
        "UPDATE profiles SET issue_watcher_enabled=1,issue_watcher_label_prefix='build' WHERE name='test-profile'",
      ).run();
      db.prepare(
        "INSERT INTO watched_issues(profile_name,provider,issue_id,issue_url,issue_title,status,trigger_label) VALUES('test-profile','github','42','https://github.com/org/repo/issues/42','Private issue title','in_progress','build')",
      ).run();
      const blocked = previewConfigurationConversion(input);
      expect(blocked.watchers.blockers).toHaveLength(1);
      expect(JSON.stringify(blocked)).not.toContain('Private issue title');
      db.prepare("UPDATE watched_issues SET status='done' WHERE issue_id='42'").run();
      const plan = previewConfigurationConversion(input);
      expect(plan.blocked).toBe(false);
      await applyConfigurationConversion({ ...input, expectedDigest: plan.digest });
      const watcher = db.prepare('SELECT id,payload FROM issue_watcher_bindings').get() as {
        id: string;
        payload: string;
      };
      expect(JSON.parse(watcher.payload)).toMatchObject({
        enabled: true,
        labelPrefix: 'build',
        launch: { repositoryId: plan.profiles.bindings[0]?.repositoryId },
      });
      db.prepare("DELETE FROM profiles WHERE name='test-profile'").run();
      expect(
        db
          .prepare("SELECT watcher_id,status,issue_title FROM watched_issues WHERE issue_id='42'")
          .get(),
      ).toEqual({ watcher_id: watcher.id, status: 'done', issue_title: 'Private issue title' });
    } finally {
      db.close();
    }
  });
  function fixture() {
    const db = createTestDb();
    insertTestProfile(db);
    db.prepare(
      "INSERT INTO memory_entries(id,scope,scope_id,path,content,content_sha256,version,approved) VALUES('memory','profile','test-profile','/setup.md','Private retained knowledge','fixture-digest',7,1)",
    ).run();
    const job = insertTestScheduledJob(db, {
      id: 'job',
      task: 'Sensitive original prompt',
      catchupPending: true,
    });
    const readProfiles = () => {
      const row = db.prepare('SELECT * FROM profiles WHERE name=?').get('test-profile') as Record<
        string,
        unknown
      >;
      return [
        {
          ...rowToProfile(row),
          providerAccountId: 'account',
          providerFailover: { targets: [], maxHops: 0 },
          testCommand: 'npm test',
        },
      ];
    };
    return { db, job, input: { db, readProfiles, bindings: {}, ownerUserId: 'operator', logger } };
  }
  it('converts profiles and schedules atomically, retaining prompts and timing, without enabling admission', async () => {
    const { db, job, input } = fixture();
    try {
      const before = db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(job.id) as Record<
        string,
        unknown
      >;
      const plan = previewConfigurationConversion(input);
      expect(plan.blocked).toBe(false);
      expect(JSON.stringify(plan)).not.toContain('Sensitive original prompt');
      expect(JSON.stringify(plan)).not.toContain('Private retained knowledge');
      const result = await applyConfigurationConversion({ ...input, expectedDigest: plan.digest });
      expect(result).toMatchObject({ applied: true, admissionEnabled: false });
      const converted = createScheduledJobRepository(db).getOrThrow(job.id);
      expect(converted.profileName).toBeNull();
      expect(converted.ownerUserId).toBe('operator');
      expect(converted.launch).toMatchObject({
        repositoryId: plan.profiles.bindings[0]?.repositoryId,
        profileId: plan.profiles.bindings[0]?.profileId,
      });
      expect(
        db
          .prepare(
            "SELECT scope,scope_id,repository_setup_id,content,version FROM memory_entries WHERE id='memory'",
          )
          .get(),
      ).toEqual({
        scope: 'repository',
        scope_id: plan.profiles.bindings[0]?.repositoryId,
        repository_setup_id: plan.profiles.bindings[0]?.setupId,
        content: 'Private retained knowledge',
        version: 7,
      });
      const after = db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(job.id) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(before)) {
        if (!['profile_name', 'launch_selection', 'owner_user_id'].includes(key))
          expect(after[key]).toEqual(value);
      }
      expect(
        (await applyConfigurationConversion({ ...input, expectedDigest: plan.digest })).applied,
      ).toBe(false);
      await expect(
        applyConfigurationConversion({
          ...input,
          ownerUserId: 'different',
          expectedDigest: plan.digest,
        }),
      ).rejects.toThrow('identity');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('rolls back the profile and memory conversion if a schedule write fails', async () => {
    const { db, input } = fixture();
    try {
      db.exec(
        "CREATE TRIGGER refuse_schedule_conversion BEFORE UPDATE OF launch_selection ON scheduled_jobs BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;",
      );
      const plan = previewConfigurationConversion(input);
      await expect(
        applyConfigurationConversion({ ...input, expectedDigest: plan.digest }),
      ).rejects.toThrow('fixture write failure');
      expect(db.prepare('SELECT count(*) AS n FROM configuration_entities').get()).toEqual({
        n: 0,
      });
      expect(db.prepare('SELECT count(*) AS n FROM configuration_conversions').get()).toEqual({
        n: 0,
      });
      expect(
        db.prepare("SELECT scope,scope_id,version FROM memory_entries WHERE id='memory'").get(),
      ).toEqual({ scope: 'profile', scope_id: 'test-profile', version: 7 });
    } finally {
      db.close();
    }
  });
  it('converts valid scan selections while retaining policy, history and enablement', async () => {
    const { db, input } = fixture();
    try {
      const policy = {
        version: 1,
        baseRef: 'main',
        headRef: 'work',
        scanners: ['secrets'],
        judgment: 'none',
      };
      db.prepare(
        "UPDATE scheduled_jobs SET scan_policy=?,enabled=0,last_run_at='2026-09-13T00:00:00Z' WHERE id='job'",
      ).run(JSON.stringify(policy));
      const plan = previewConfigurationConversion(input);
      expect(plan.blocked).toBe(false);
      await applyConfigurationConversion({ ...input, expectedDigest: plan.digest });
      expect(createScheduledJobRepository(db).getOrThrow('job')).toMatchObject({
        profileName: null,
        enabled: false,
        lastRunAt: '2026-09-13T00:00:00Z',
        scan: policy,
        launch: {
          repositoryId: plan.profiles.bindings[0]?.repositoryId,
          profileId: plan.profiles.bindings[0]?.profileId,
        },
      });
    } finally {
      db.close();
    }
  });
  it('refuses a stale schedule or malformed scan without modifying configuration', async () => {
    const { db, input } = fixture();
    try {
      const plan = previewConfigurationConversion(input);
      db.prepare("UPDATE scheduled_jobs SET cron_expression='0 10 * * *' WHERE id='job'").run();
      await expect(
        applyConfigurationConversion({ ...input, expectedDigest: plan.digest }),
      ).rejects.toThrow('changed');
      expect(db.prepare('SELECT count(*) AS n FROM configuration_entities').get()).toEqual({
        n: 0,
      });
      db.prepare("UPDATE scheduled_jobs SET scan_policy='{}' WHERE id='job'").run();
      const scan = previewConfigurationConversion(input);
      expect(scan.blocked).toBe(true);
      expect(scan.schedules.blockers).toHaveLength(1);
      await expect(
        applyConfigurationConversion({ ...input, expectedDigest: scan.digest }),
      ).rejects.toThrow('blocker');
    } finally {
      db.close();
    }
  });
});
