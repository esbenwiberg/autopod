import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach } from 'vitest';
import { AzureSandboxApiClient } from '../containers/azure-sandbox-api-client.js';
import { createSandboxWakeupJournal } from '../containers/sandbox-wakeup-journal.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { createTestDb } from './mock-helpers.js';

export const TEST_WAKEUP_ID = 'synthetic-worker';
export const TEST_WAKEUP_KEY =
  'https://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourcegroups/rg-1/sandboxgroups/autopod-spike/sandboxes/synthetic-worker';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

/** Synthetic admitted transport for cleanup guards; not live provider evidence. */
export function retainTestWakeup(repo: Pick<PodRepository, 'sandboxWakeups'>, sandboxId: string) {
  const journal = repo.sandboxWakeups;
  if (!journal) throw new Error('Missing wakeup journal');
  const key = `https://example.invalid/sandboxes/${sandboxId}`;
  journal.observeRunning(key, sandboxId);
  const intent = journal.claim(key, sandboxId, 'prepare');
  journal.beginDispatch(intent.id);
  return { journal, key, intentId: intent.id };
}

export function createDelayedWakeupCredential() {
  let calls = 0;
  let release: ((token: { token: string }) => void) | undefined;
  return {
    credential: {
      getToken: async () => {
        if (++calls === 1) return { token: 'test-token' };
        return new Promise<{ token: string }>((resolve) => {
          release = resolve;
        });
      },
    },
    release() {
      if (!release) throw new Error('No pending token request');
      release({ token: 'test-token' });
    },
  };
}

type ClientConfig = ConstructorParameters<typeof AzureSandboxApiClient>[0];
export function createTestWakeupClient(
  journal: ClientConfig['wakeupJournal'],
  fetch: NonNullable<ClientConfig['fetch']>,
  config: Partial<ClientConfig> = {},
) {
  return new AzureSandboxApiClient(
    {
      subscriptionId: 'sub-1',
      resourceGroup: 'rg-1',
      location: 'swedencentral',
      sandboxGroup: 'autopod-spike',
      credential: { getToken: async () => ({ token: 'test-token' }) },
      wakeupJournal: journal,
      fetch,
      pollIntervalMs: 10,
      resumeTimeoutMs: 50,
      ...config,
    },
    pino({ level: 'silent' }),
  );
}

export function createSandboxWakeupFixture(knownRunning = false, disk = false) {
  let db = createTestDb();
  const dir = disk ? mkdtempSync(join(tmpdir(), 'autopod-wakeup-test-')) : null;
  const file = dir ? join(dir, 'state.db') : null;
  if (file) {
    writeFileSync(file, db.serialize());
    db.close();
    db = new Database(file);
  }
  let journal = createSandboxWakeupJournal(db);
  // Synthetic backend observation in a test fixture, never live provider proof.
  if (knownRunning) journal.observeRunning(TEST_WAKEUP_KEY, TEST_WAKEUP_ID);
  cleanups.push(() => {
    if (db.open) db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    get journal() {
      return journal;
    },
    reopen() {
      if (!file) throw new Error('Disk fixture required');
      db.close();
      db = new Database(file);
      journal = createSandboxWakeupJournal(db);
      return journal;
    },
  };
}
