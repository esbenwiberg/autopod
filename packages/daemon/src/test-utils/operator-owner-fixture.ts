import Database from 'better-sqlite3';
import { claimDaemonLifetime } from '../orchestration/local-recovery-claim.js';

// Keep the owning process and its open connection alive at an explicit IPC barrier.
const databasePath = process.argv[2];
if (!databasePath) throw new Error('missing-fixture-database');
const db = new Database(databasePath, { fileMustExist: true });
const owner = claimDaemonLifetime(db);
if (!process.send) throw new Error('owner-fixture-failed');
process.on('disconnect', () => {
  owner.close();
  db.close();
});
process.send({ type: 'ready' });
