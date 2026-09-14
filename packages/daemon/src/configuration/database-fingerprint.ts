import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Content identity, including ledgers and schema. Backup page layout/WAL placement is irrelevant.
 * The cutover receipt excludes itself; all operational tables remain included.
 */
export function configurationDatabaseFingerprint(db: Database.Database): string {
  const hash = createHash('sha256');
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name != 'configuration_cutover' ORDER BY type,name",
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  hash.update(JSON.stringify(schema));
  let rows = 0;
  let bytes = 0;
  for (const entry of schema) {
    if (entry.type !== 'table') continue;
    const table = `"${entry.name.replaceAll('"', '""')}"`;
    const digests: string[] = [];
    for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
      const encoded = JSON.stringify(row);
      bytes += Buffer.byteLength(encoded);
      if (++rows > 2_000_000 || bytes > 2_000_000_000)
        throw new Error('Database exceeds the bounded cutover fingerprint capacity');
      digests.push(createHash('sha256').update(encoded).digest('hex'));
    }
    hash.update(JSON.stringify(entry.name));
    for (const digest of digests.sort()) hash.update(digest);
  }
  return hash.digest('hex');
}
