import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pino from 'pino';
import { z } from 'zod';
import { createEntraAuthModule } from '../auth/entra-auth-module.js';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { createDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { sha256 } from '../managed/canonical.js';
import { createProviderAccountStore } from '../provider-accounts/index.js';
import { claimDaemonLifetime } from './local-recovery-claim.js';
import {
  candidateAccountIds,
  registerCandidateAccountSetup,
} from './parent-candidate-account-setup.js';
import { parentCandidateSeed } from './parent-candidate-host.js';

async function existing(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
async function checkDir(dir: string, uid: number) {
  const stat = await lstat(dir);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 ||
    dir !== (await realpath(dir))
  )
    throw new Error('unsafe setup directory');
}
async function checkFile(file: string, uid: number) {
  const stat = await existing(file);
  if (stat && (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.mode & 0o077))
    throw new Error('unsafe setup file');
  return stat;
}

try {
  const [root, tenantId, clientId, oid, portRaw, ...extra] = process.argv.slice(2);
  const uuid = z.uuid();
  const uid = process.getuid?.();
  const port = Number(portRaw);
  if (
    !root ||
    !path.isAbsolute(root) ||
    !uid ||
    extra.length ||
    !tenantId ||
    !uuid.safeParse(tenantId).success ||
    !clientId ||
    !uuid.safeParse(clientId).success ||
    !oid ||
    !uuid.safeParse(oid).success ||
    !/^[0-9]{4,5}$/.test(portRaw ?? '') ||
    port < 1024 ||
    port > 65535
  )
    throw new Error('setup arguments');
  process.umask(0o077);
  const home = path.join(root, 'home'),
    state = path.join(home, '.autopod');
  await checkDir(root, uid);
  await checkDir(home, uid);
  const seedPath = path.join(root, 'seed.bundle');
  const seed = await checkFile(seedPath, uid);
  if (
    !seed ||
    seed.size > 4096 ||
    sha256(await readFile(seedPath)) !== parentCandidateSeed.bundleDigest
  )
    throw new Error('wrong seed');
  const database = path.join(root, 'autopod.db');
  // This command initializes exactly once. Refuse any previous database, sidecar,
  // key state or setup attempt before opening SQLite for writes.
  for (const name of [
    'autopod.db',
    'autopod.db-wal',
    'autopod.db-shm',
    'autopod.db-journal',
    'autopod.db.controller-owners',
  ]) {
    if (await existing(path.join(root, name))) throw new Error('setup requires a fresh candidate');
  }
  // Exclusive directory creation is the first write and serializes setup attempts.
  // Keep it on failure: do not resume or overwrite partial credential custody.
  await mkdir(state, { mode: 0o700 });
  const cipher = loadOrCreateKey(path.join(state, 'secrets.key'));
  const db = createDatabase(database, pino({ level: 'silent' }));
  const lifetime = claimDaemonLifetime(db);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, requestTimeout: 10_000 });
  try {
    runMigrations(
      db,
      fileURLToPath(new URL('../db/migrations/', import.meta.url)),
      pino({ level: 'silent' }),
    );
    for (const table of ['retained_pods', 'managed_pods', 'orchestration_runs', 'scheduled_jobs']) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw new Error('not an unused candidate');
    }
    const accounts = createProviderAccountStore(db, cipher);
    db.transaction(() => {
      for (const id of candidateAccountIds) accounts.create({ id, name: id, provider: 'openai' });
    })();
    const auth = createEntraAuthModule({
      tenantId,
      clientId,
      acceptedAudiences: [clientId, `api://${clientId}`],
    });
    const bindingPath = path.join(state, 'candidate-owner.json');
    let binding: string | undefined;
    registerCandidateAccountSetup(app, auth, oid, accounts, (owner) => {
      const observed = JSON.stringify(owner);
      if (binding && binding !== observed) throw new Error('owner binding changed');
      if (!binding) {
        writeFileSync(bindingPath, observed + '\n', { flag: 'wx', mode: 0o600 });
        binding = observed;
      }
    });
    const address = await app.listen({ host: '127.0.0.1', port });
    process.stdout.write(`Candidate account setup only: ${address}\n`);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await app.close();
    lifetime.close();
    db.close();
  }
} catch {
  // These paths handle fresh credentials. Do not log request bodies or raw parsing errors.
  process.stderr.write('parent-candidate-account-setup-refused\n');
  process.exitCode = 1;
}
