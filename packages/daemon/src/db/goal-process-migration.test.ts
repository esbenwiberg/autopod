import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('preserves recorded Docker processes and their immutable ownership while adding sandbox identities', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec("CREATE TABLE pods(id TEXT PRIMARY KEY); INSERT INTO pods VALUES ('owner')");
    db.exec(
      readFileSync(new URL('./migrations/204_native_goal_processes.sql', import.meta.url), 'utf8'),
    );
    db.prepare(`INSERT INTO pod_goal_processes(exec_id,pod_id,attempt_id,generation,configuration_digest,account_id,backend,container_id,pid_path,role,created_at,started_at)
      VALUES('docker-exec','owner','attempt',1,'digest','account','docker','container','/tmp/old.pid','agent','created','started')`).run();
    const before = db.prepare('SELECT * FROM pod_goal_processes').get();
    db.transaction(() =>
      db.exec(
        readFileSync(
          new URL('./migrations/210_sandbox_goal_processes.sql', import.meta.url),
          'utf8',
        ),
      ),
    )();
    expect(
      db.prepare("SELECT * FROM pod_goal_processes WHERE exec_id='docker-exec'").get(),
    ).toEqual(before);
    expect(() => db.prepare("UPDATE pod_goal_processes SET account_id='other'").run()).toThrow(
      'immutable',
    );
    expect(() => db.prepare("UPDATE pod_goal_processes SET started_at='different'").run()).toThrow(
      'immutable',
    );
    db.prepare(`INSERT INTO pod_goal_processes(exec_id,pod_id,attempt_id,generation,configuration_digest,account_id,backend,container_id,pid_path,role,created_at)
      VALUES('sandbox-exec','owner','attempt',1,'digest','account','sandbox','sandbox','/run/state.json','inspection','created')`).run();
    db.prepare(
      "UPDATE pod_goal_processes SET stopped_at='stopped',exit_code=143 WHERE exec_id='sandbox-exec'",
    ).run();
    expect(() =>
      db.prepare("UPDATE pod_goal_processes SET exit_code=0 WHERE exec_id='sandbox-exec'").run(),
    ).toThrow('immutable');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    db.close();
  }
});
