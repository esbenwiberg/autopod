/** Disposable real-Docker timing/SQLite protocol proof, NOT task/model qualification.
 * Requires an already-present exact image with node, sleep and user autopod.
 * No credentials, production DB, image pulls or real pod IDs are used.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import Dockerode from 'dockerode';
import pino from 'pino';
import { runMigrations } from '../db/migrate.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { createPodRepository } from '../pods/pod-repository.js';
import {
  checkpointHash,
  checkpointResourceIdentity,
} from '../pods/retained-checkpoint-repository.js';
import { validateTransition } from '../pods/state-machine.js';
import { createValidationExecution } from '../pods/validation-execution.js';
import { captureValidationOwnership } from '../pods/validation-ownership.js';
import { createProfileStore } from '../profiles/profile-store.js';
import { DockerContainerManager } from './docker-container-manager.js';

const root = process.env.AUTOPOD_SOURCE_ROOT;
const image = process.env.AUTOPOD_DOCKER_CUSTODY_IMAGE;
assert(root && image && /^sha256:[a-f0-9]{64}$/.test(image));
const docker = new Dockerode();
await docker.getImage(image).inspect();
const fixture = `budget-fixture-${randomUUID()}`;
const logger = pino({ level: 'silent' });
const db = new Database(':memory:');
runMigrations(db, path.join(root, 'packages/daemon/src/db/migrations'), logger);
db.prepare(`INSERT INTO profiles(name,repo_url,build_command,start_command,test_timeout)
  VALUES('budget-fixture','https://example.invalid/fixture','','',1)`).run();
const repo = createPodRepository(db);
const checkpoints = repo.retainedCheckpoints!;
const retries = repo.taskRetries!;
const manager = new DockerContainerManager({ docker, logger, managedDatabase: db });
const created: string[] = [];
const spawn = {
  podId: fixture,
  image,
  env: { POD_ID: fixture },
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 1e9,
  onCreated: (id: string) => {
    created.push(id);
  },
};
function result(): ValidationResult {
  return {
    podId: fixture,
    attempt: 1,
    timestamp: new Date().toISOString(),
    overall: 'pass',
    duration: 1,
    smoke: {
      status: 'pass',
      build: { status: 'skip', output: '', duration: 0 },
      health: { status: 'skip', url: '', responseCode: null, duration: 0 },
      pages: [],
    },
    taskReview: null,
  };
}
let success = false;
try {
  const original = await manager.spawn(spawn);
  await manager.stop(original);
  const before = await docker.getContainer(original).inspect();
  repo.insert({
    id: fixture,
    profileName: 'budget-fixture',
    task: 'Synthetic budget protocol fixture',
    status: 'review_required',
    runtime: 'codex',
    model: 'fixture',
    executionTarget: 'local',
    branch: 'fixture',
    userId: 'fixture',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    options: { agentMode: 'auto', output: 'pr', validate: true, validationSuite: 'full' },
  });
  const failed = { ...result(), overall: 'fail' as const };
  repo.update(fixture, {
    containerId: original,
    worktreePath: '/fixture-original',
    lastValidationResult: failed,
  });
  const actor = { type: 'human' as const, userId: 'fixture' };
  const request = {
    id: fixture,
    expectedGeneration: 1,
    expectedResultHash: checkpointHash(failed),
    checkpointHead: 'a'.repeat(40),
    reason: 'Synthetic owned protocol qualification only',
  };
  checkpoints.claim({
    pod: repo.getOrThrow(fixture),
    taskId: repo.taskExecutions!.snapshot(fixture).taskId,
    resourceKey: `fixture:${original}`,
    request,
    actor,
    assertCurrent() {},
    binding: {
      branch: 'fixture',
      head: request.checkpointHead,
      repository: 'https://example.invalid/fixture',
      cycle: 0,
      resultHash: request.expectedResultHash,
      configurationHash: 'b'.repeat(64),
      continuation: { prepareOnly: true },
    },
  });
  checkpoints.append(fixture, 'prepared', {
    worktree: '/fixture-selected',
    head: request.checkpointHead,
    tree: 'b'.repeat(40),
  });
  await checkpoints.owned(fixture, async () => {
    repo.atomically!(() => {
      checkpoints.select(fixture, {
        head: request.checkpointHead,
        tree: 'b'.repeat(40),
        actor,
        reason: request.reason,
        requestHash: checkpointHash(request),
        testBudget: {
          seconds: 3,
          frozenTimeoutSeconds: 1,
          reason: 'One synthetic finite outer-test timing qualification',
        },
      });
      const generation = repo.incrementLifecycleGeneration(fixture);
      repo.update(fixture, {
        containerId: null,
        worktreePath: '/fixture-selected',
        skipAgent: true,
      });
      checkpoints.append(fixture, 'activated', { generation });
    });
    const current = await manager.spawn({
      ...spawn,
      resourceIdentity: checkpointResourceIdentity(fixture, fixture, 2),
    });
    repo.update(fixture, { containerId: current });
    for (const status of ['queued', 'provisioning', 'running', 'validating'] as const) {
      validateTransition(fixture, repo.getOrThrow(fixture).status, status);
      repo.update(fixture, { status });
    }
    checkpoints.append(fixture, 'checking', { generation: 2 });
    const command = ['node', '-e', 'setTimeout(()=>console.log("native-budget-ok"),1400)'];
    // This timed-out disposable control can continue until fixture cleanup; it is
    // not termination evidence, and no real resource or original is executed.
    await assert.rejects(manager.execInContainer(current, command, { timeout: 1000 }), /timed out/);
    const config: ValidationEngineConfig = {
      podId: fixture,
      containerId: current,
      executionTarget: 'local' as const,
      attempt: 1,
      worktreePath: '/fixture-selected',
      previewUrl: '',
      task: 'Synthetic protocol fixture',
      diff: '',
      buildCommand: '',
      startCommand: '',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [],
      testCommand: 'synthetic-node-timer',
      testTimeout: 1000,
      validationSuite: 'full' as const,
    };
    const ownership = captureValidationOwnership(repo.getOrThrow(fixture), {
      readCurrent: () => repo.getOrThrow(fixture),
      isCurrentInvocation: () => true,
      hasPendingDecision: () => false,
    });
    let calls = 0;
    const execution = createValidationExecution({
      logger,
      podRepo: repo,
      containerManagerFactory: { get: () => manager },
      validationEngine: {
        async validate(input) {
          calls++;
          assert.equal(input.testTimeout, 1000);
          assert.equal(input.outerTestTimeout, 3000);
          const output = await manager.execInContainer(current, command, {
            timeout: input.outerTestTimeout,
          });
          assert.equal(output.exitCode, 0);
          assert.match(output.stdout, /native-budget-ok/);
          return result();
        },
      },
      retrySource: {
        validationInfrastructureRetryBackoffMs: [],
        async captureRetryIdentity(input) {
          assert.equal(input.testTimeout, 1000);
          return {
            source: 'a'.repeat(64),
            contract: 'b'.repeat(64),
            commands: 'c'.repeat(64),
            environment: null,
            implementation: null,
          };
        },
      },
      async recordValidationProvenance() {},
      resolveEffectiveBoundProfile: () => createProfileStore(db).get('budget-fixture'),
      withReviewerLaunchPreflight: (input) => input,
      ownedValidationCallbacks: (_owner, callbacks) => callbacks ?? {},
      emitActivityStatus() {},
      publishValidationResult() {},
      makeUnexpectedValidationFailureResult(_pod, _attempt, error) {
        throw error;
      },
      validationInfrastructureFailureLabel: () => 'fixture',
      isReviewInfrastructureOnlyFailure: () => false,
      reviewInfrastructureFailureLabel: () => 'fixture',
    });
    const run = () =>
      execution.validateWithInfrastructureRetries(
        config,
        new AbortController(),
        undefined,
        'fixture',
        ownership,
      );
    assert.equal((await run()).overall, 'pass');
    assert.equal(config.testTimeout, 1000);
    assert.equal(config.outerTestTimeout, undefined);
    assert.equal(retries.state(fixture).executedCount, 1);
    assert.equal(checkpoints.testBudget(repo.getOrThrow(fixture), 1000)?.used, true);
    await assert.rejects(run(), /no replay/);
    assert.equal(calls, 1);
  });
  const after = await docker.getContainer(original).inspect();
  assert.equal(after.Id, before.Id);
  assert.equal(after.Name, before.Name);
  assert.equal(after.State.Running, false);
  console.log(
    JSON.stringify({
      marker: 'NATIVE_RETAINED_TEST_BUDGET_PASSED',
      image,
      fixture,
      frozenMs: 1000,
      selectedMs: 3000,
      commandMs: 1400,
      originalUnchanged: true,
      validationExecutions: retries.state(fixture).executedCount,
      liveTaskOrModelQualification: false,
    }),
  );
  success = true;
} finally {
  for (const id of created.reverse()) {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    assert(
      info.Name.startsWith(`/autopod-${fixture}`) && info.Config.Env?.includes(`POD_ID=${fixture}`),
    );
    await container.remove({ force: true });
  }
  db.close();
}
assert(success);
console.log('OWNED_BUDGET_FIXTURE_CLEANUP_PASSED');
