import Database from 'better-sqlite3';
import { tryOperatorDaemonOwner } from '../orchestration/local-recovery-claim.js';

// Keep the owning process and its open connection alive at an explicit IPC barrier.
const databasePath = process.argv[2];
if (!databasePath) throw new Error('missing-fixture-database');
const db = new Database(databasePath, { fileMustExist: true });
const release = tryOperatorDaemonOwner(db);
if (!release || !process.send) throw new Error('owner-fixture-failed');
process.on('disconnect', () => {
  release();
  db.close();
});
process.send({ type: 'ready' });
