import type Database from 'better-sqlite3';

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Migration 194. Keep the accumulated pod schema, rows, indexes and triggers exactly as stored. */
export function detachLegacyPodProfile(db: Database.Database): void {
  detach(db, 'pods', false);
}

export function detachLegacyScheduledProfile(db: Database.Database): void {
  detach(db, 'scheduled_jobs', true);
}

export function detachLegacyWatchedProfile(db: Database.Database): void {
  detach(db, 'watched_issues', false);
}

function detach(
  db: Database.Database,
  tableName: 'pods' | 'scheduled_jobs' | 'watched_issues',
  nullable: boolean,
): void {
  if (!db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 0)
    throw new Error(
      'Profile identity migration requires a transaction with foreign keys suspended',
    );
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { sql: string } | undefined;
  if (!table) throw new Error('Pod schema is unavailable');
  const constraint =
    /\b(profile_name\s+TEXT\s+NOT\s+NULL)\s+REFERENCES\s+"?profiles"?\s*\(\s*name\s*\)(?:\s+ON\s+DELETE\s+CASCADE)?/gi;
  if ([...table.sql.matchAll(constraint)].length !== 1)
    throw new Error('Unexpected legacy pod profile constraint; database retained unchanged');
  const target = `${tableName}_configuration_identity`;
  const create = table.sql
    .replace(new RegExp(`^CREATE TABLE\\s+"?${tableName}"?`, 'i'), `CREATE TABLE ${quote(target)}`)
    .replace(constraint, nullable ? 'profile_name TEXT' : '$1');
  if (create === table.sql || create.includes('REFERENCES profiles(name)'))
    throw new Error('Pod identity migration did not isolate the expected constraint');
  const dependentSchema = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND ((tbl_name=? AND type='index') OR type IN ('view','trigger')) ORDER BY rowid",
    )
    .all(tableName) as Array<{ type: string; name: string; sql: string }>;
  const beforeForeignKeys = JSON.stringify(db.pragma('foreign_key_check'));
  const columns = (db.pragma(`table_info(${tableName})`) as Array<{ name: string }>)
    .map(({ name }) => quote(name))
    .join(',');
  db.exec(create);
  db.exec(`INSERT INTO ${quote(target)} (${columns}) SELECT ${columns} FROM ${quote(tableName)}`);
  for (const [a, b] of [
    [tableName, target],
    [target, tableName],
  ] as const) {
    if (
      db
        .prepare(
          `SELECT ${columns} FROM ${quote(a)} EXCEPT SELECT ${columns} FROM ${quote(b)} LIMIT 1`,
        )
        .get()
    )
      throw new Error('Pod identity migration changed retained rows');
  }
  // SQLite validates dependent views during ALTER TABLE; recreate their exact definitions afterwards.
  for (const entry of dependentSchema.filter((item) => item.type !== 'index'))
    db.exec(`DROP ${entry.type === 'view' ? 'VIEW' : 'TRIGGER'} ${quote(entry.name)}`);
  db.exec(
    `DROP TABLE ${quote(tableName)}; ALTER TABLE ${quote(target)} RENAME TO ${quote(tableName)}`,
  );
  for (const entry of dependentSchema) db.exec(entry.sql);
  if (JSON.stringify(db.pragma('foreign_key_check')) !== beforeForeignKeys)
    throw new Error('Pod identity migration changed foreign key integrity');
}
