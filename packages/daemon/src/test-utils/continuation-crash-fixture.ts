// POSIX crash barrier for the internal scheduler test. No daemon listener or live runtime.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import { REQUIRED_ENFORCEMENT } from '../managed/grants.js';
import { ManagedPodService } from '../managed/managed-service.js';
import { managedGit } from '../managed/source-git.js';
import {
  type ContinuationCheckpoint,
  OrchestrationContinuations,
} from '../orchestration/continuations.js';

const [database, payload, mode] = process.argv.slice(2);
if (!database || !payload) throw new Error('missing-fixture-input');
const { cp, request }: { cp: ContinuationCheckpoint; request: ManagedPodRequest } = JSON.parse(
  readFileSync(payload, 'utf8'),
);
const db = new Database(database, { fileMustExist: true });
const profile = request.profileSnapshot;
const managed = new ManagedPodService(
  db,
  {
    profiles: new Map([[profile.snapshotDigest, profile]]),
    enrollmentCeiling: profile.scope,
    identityCeiling: profile.scope,
    backendCeiling: profile.scope,
    enforcement: REQUIRED_ENFORCEMENT,
    targets: ['local'],
  },
  {
    async preflight() {},
    async ensure(id, _req, checkpoint) {
      checkpoint(id);
      if (mode === 'allocated') process.kill(process.pid, 'SIGKILL');
      const root = path.dirname(payload);
      const cwd = path.join(root, id);
      await managedGit(root, [
        'clone',
        '--no-local',
        '--no-checkout',
        path.join(root, 'retained'),
        cwd,
      ]);
      await managedGit(cwd, ['checkout', '--detach', cp.commit]);
      return { runtimeRef: id };
    },
    async observe() {
      throw new Error('unexpected observation');
    },
    async stop() {
      throw new Error('unexpected stop');
    },
  },
  () => 100,
  true,
);
const ledger = new OrchestrationContinuations(db, async () => managed);
await ledger.acceptAndContinue(cp, request);
if (mode === 'lost-handle') {
  const start = managed.start.bind(managed);
  managed.start = async (...args) => {
    await start(...args);
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  };
}
if (mode === 'allocated' || mode === 'lost-handle') await ledger.recover();
else process.kill(process.pid, 'SIGKILL');
throw new Error('expected abrupt termination');
