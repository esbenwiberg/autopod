// Plain Node entry point: deliberately does not import Vitest or mock-helpers.
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Pod } from '@autopod/shared';
import pino from 'pino';
import { createDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { EventBus } from '../pods/event-bus.js';
import { type ReconcileResult, reconcileLocalSessions } from '../pods/local-reconciler.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { validateTransition } from '../pods/state-machine.js';
import { createValidationRepository } from '../pods/validation-repository.js';

export interface DurableSnapshot {
  status: Pod['status'];
  generation: number;
  branch: string;
  startCommitSha: string | null;
  worktreePath: string | null;
  containerId: string | null;
  pendingEscalation: Pod['pendingEscalation'];
  journal: Pod['finalization'];
  escalations: unknown[];
  decisions: unknown[];
  agentRuns: unknown[];
  cleanupIntents: unknown[];
}

interface ProcessIdentity {
  pid: number;
  isolation: { home: string; tmp: string; cwd: string };
  open: boolean;
}
export type FixtureMessage = ProcessIdentity &
  (
    | { type: 'ready'; inTransaction: boolean; snapshot: DurableSnapshot }
    | {
        type: 'recovered';
        before: DurableSnapshot;
        passes: {
          result: ReconcileResult;
          snapshot: DurableSnapshot;
          lastRecoveryTrigger: Pod['lastRecoveryTrigger'];
          lastCorrectionMessage: Pod['lastCorrectionMessage'];
        }[];
        afterDuplicate: DurableSnapshot;
        effects: string[];
        integrity: unknown;
        foreignKeys: unknown;
      }
  );

async function run() {
  const [mode, filename, migrations, root] = process.argv.slice(2);
  assert(mode === 'write' || mode === 'recover');
  assert(filename && migrations && root);
  assert(path.isAbsolute(filename) && path.isAbsolute(migrations) && path.isAbsolute(root));
  const isolation = { home: homedir(), tmp: tmpdir(), cwd: process.cwd() };
  assert.deepEqual(isolation, {
    home: path.join(root, 'home'),
    tmp: path.join(root, 'tmp'),
    cwd: root,
  });
  const logger = pino({ level: 'silent' });
  const db = createDatabase(filename, logger);
  runMigrations(db, migrations, logger);
  const repo = createPodRepository(db);
  const journal = repo.completionJournal;
  assert(journal, 'Production completion journal must exist');

  const snapshot = (): DurableSnapshot => {
    const pod = repo.getOrThrow('settled');
    return {
      status: pod.status,
      generation: pod.lifecycleGeneration,
      branch: pod.branch,
      startCommitSha: pod.startCommitSha,
      worktreePath: pod.worktreePath,
      containerId: pod.containerId,
      pendingEscalation: pod.pendingEscalation,
      journal: journal.get(pod.id, pod.lifecycleGeneration),
      escalations: db.prepare('SELECT * FROM escalations ORDER BY id').all(),
      decisions: db.prepare('SELECT * FROM completion_decisions ORDER BY rowid').all(),
      agentRuns: db.prepare('SELECT * FROM task_agent_runs').all(),
      cleanupIntents: db.prepare('SELECT * FROM deletion_cleanup_intents').all(),
    };
  };

  if (mode === 'write') {
    db.prepare(`INSERT INTO profiles(name,repo_url,build_command,start_command)
      VALUES('crash-fixture','https://example.invalid/fixture','echo build','echo start')`).run();
    repo.insert({
      id: 'settled',
      profileName: 'crash-fixture',
      task: 'Collect findings and wait for a decision',
      status: 'queued',
      model: 'gpt-5.6-sol',
      runtime: 'codex',
      executionTarget: 'local',
      branch: 'fixture/retained-decision',
      userId: 'fixture-user',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    for (const status of ['provisioning', 'running', 'awaiting_input'] as const) {
      validateTransition('settled', repo.getOrThrow('settled').status, status);
      repo.update('settled', { status });
    }
    const payload = { question: 'Select findings' };
    db.prepare('INSERT INTO escalations(id,pod_id,type,payload) VALUES(?,?,?,?)').run(
      'decision',
      'settled',
      'ask_human',
      JSON.stringify(payload),
    );
    repo.update('settled', {
      pendingEscalation: { id: 'decision', podId: 'settled', type: 'ask_human', payload },
      worktreePath: path.join(root, 'worktree'),
      containerId: 'fixture-container',
      startCommitSha: 'a'.repeat(40),
    });
    const pod = repo.getOrThrow('settled');
    journal.settle(pod, 'Report collected');
    journal.mark(pod, 'awaiting_human', true);
    // A message listener keeps IPC referenced. Only the parent kills this writer;
    // there is intentionally no graceful DB close or process.exit on this path.
    process.on('message', () => {
      throw new Error('Writer accepts no commands; parent must use SIGKILL');
    });
    await send({
      type: 'ready',
      pid: process.pid,
      isolation,
      open: db.open,
      inTransaction: db.inTransaction,
      snapshot: snapshot(),
    });
    return;
  }

  const effects: string[] = [];
  const unexpected = (operation: string): never => {
    effects.push(operation);
    throw new Error(`Unexpected recovery side effect: ${operation}`);
  };
  const containerManager: ContainerManager = {
    spawn: async () => unexpected('container.spawn'),
    kill: async () => unexpected('container.kill'),
    stop: async () => unexpected('container.stop'),
    start: async () => unexpected('container.start'),
    refreshFirewall: async () => unexpected('container.refreshFirewall'),
    writeFile: async () => unexpected('container.writeFile'),
    readFile: async () => unexpected('container.readFile'),
    readFileBinary: async () => unexpected('container.readFileBinary'),
    extractDirectoryFromContainer: async () => unexpected('container.extractDirectory'),
    getStatus: async () => unexpected('container.getStatus'),
    execInContainer: async () => unexpected('container.execInContainer'),
    execStreaming: async () => unexpected('container.execStreaming'),
  };
  const eventBus: EventBus = {
    emit: () => unexpected('event.emit'),
    subscribe: () => unexpected('event.subscribe'),
    subscribeToSession: () => unexpected('event.subscribeToSession'),
  };
  const deps = {
    podRepo: repo,
    validationRepo: createValidationRepository(db),
    containerManager,
    eventBus,
    enqueueSession: () => unexpected('enqueue'),
    cleanupPodResources: async () => unexpected('cleanup'),
    logger,
    trigger: 'restart' as const,
  };
  const before = snapshot();
  const passes = [];
  for (let pass = 0; pass < 2; pass++) {
    const result = await reconcileLocalSessions(deps);
    const pod = repo.getOrThrow('settled');
    passes.push({
      result,
      snapshot: snapshot(),
      lastRecoveryTrigger: pod.lastRecoveryTrigger,
      lastCorrectionMessage: pod.lastCorrectionMessage,
    });
  }
  const pod = repo.getOrThrow('settled');
  journal.settle(pod, 'Duplicate must not overwrite report');
  journal.mark(pod, 'finished');
  const afterDuplicate = snapshot();
  const integrity = db.pragma('integrity_check', { simple: true });
  const foreignKeys = db.pragma('foreign_key_check');
  db.close();
  await send({
    type: 'recovered',
    pid: process.pid,
    isolation,
    before,
    passes,
    afterDuplicate,
    effects,
    integrity,
    foreignKeys,
    open: db.open,
  });
  process.disconnect();
}

async function send(message: FixtureMessage): Promise<void> {
  assert(process.send, 'This fixture must run with a private IPC channel');
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => (error ? reject(error) : resolve()));
  });
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
