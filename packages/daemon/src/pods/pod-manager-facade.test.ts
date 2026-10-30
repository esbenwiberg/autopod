import { describe, expect, it, vi } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import {
  createAdmissionFixture,
  deferred,
  flushAdmission,
} from '../test-utils/admission-queries-helpers.js';
import { createPodManagerFacade } from './pod-manager-facade.js';
import { createPodManager } from './pod-manager.js';
import type { ValidationWorkflowCalls } from './validation-workflow-ports.js';
vi.mock('./pod-manager-facade.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./pod-manager-facade.js')>();
  return { ...original, createPodManagerFacade: vi.fn(original.createPodManagerFacade) };
});
function instance(disk = false) {
  const f = createAdmissionFixture(disk);
  const manager = f.manager();
  const owners = vi.mocked(createPodManagerFacade).mock.calls.at(-1)?.[0];
  if (!owners) throw new Error('Missing real facade boundary');
  return {
    ...f,
    get db() {
      return f.db;
    },
    manager,
    owners,
  };
}
describe('composed pod manager facade boundary', () => {
  it('adds no extra infrastructure construction effects and preserves actual shorthand function identities', () => {
    const f = instance();
    expect(Object.keys(f.manager)).toHaveLength(83);
    expect(f.manager.acceptFindings).toBeTypeOf('function');
    expect(f.manager.adoptSource).toBeTypeOf('function');
    expect(f.manager.getSourceAdoptions).toBeTypeOf('function');
    expect(f.manager.reconcileTermination).toBeTypeOf('function');
    expect(f.manager.getValidationExecutionRecovery).toBe(
      f.owners.validationExecutionRecovery.getValidationExecutionRecovery,
    );
    expect(f.manager.reconcileValidationExecution).toBe(
      f.owners.validationExecutionRecovery.reconcileValidationExecution,
    );
    expect(f.manager.authorizeValidationRecoveryBudget).toBeTypeOf('function');
    expect(f.manager.readValidationEvidence).toBe(
      f.owners.validationExecutionRecovery.readValidationEvidence,
    );
    expect(f.manager.touchHeartbeat).toBe(f.owners.touchHeartbeat);
    expect(f.manager.getReviewerExecutor).toBe(f.owners.getReviewerExecutor);
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });
  it('preserves synchronous errors and direct returned promise identity at the API boundary', async () => {
    const f = instance();
    const error = new Error('Synthetic repository failure');
    f.owners.admissionQueries.getSession = () => {
      throw error;
    };
    expect(() => f.manager.getSession('prepare')).toThrow(error);
    const gate = deferred<{ pushError?: string }>();
    f.owners.workspaceCompletion.completeSession = () => gate.promise;
    const pending = f.manager.completeSession('prepare');
    expect(pending).toBe(gate.promise);
    gate.resolve({ pushError: 'Synthetic publication refusal' });
    await expect(pending).resolves.toEqual({ pushError: 'Synthetic publication refusal' });
  });
  it('preserves the explicit async process wrapper rather than returning its owner promise directly', async () => {
    const f = instance();
    const gate = deferred();
    f.owners.processWorkflow.processPod = () => gate.promise;
    const pending = f.manager.processPod('prepare');
    expect(pending).not.toBe(gate.promise);
    gate.resolve();
    await expect(pending).resolves.toBeUndefined();
  });
  it('passes original default attempt and lifecycle through the stream entry', async () => {
    const f = instance();
    const consume = vi.fn<typeof f.owners.agentEventConsumption.consumeAgentEvents>(
      async () => 'completed',
    );
    f.owners.agentEventConsumption.consumeAgentEvents = consume;
    const stream = (async function* () {})();
    await expect(f.manager.consumeAgentEvents('prepare', stream)).resolves.toBe('completed');
    expect(consume).toHaveBeenCalledExactlyOnceWith('prepare', stream, 0, undefined);
  });
  it('retains separate watchdog interval ownership and original stop behavior across manager instances', () => {
    const first = instance();
    const second = instance();
    vi.useFakeTimers();
    try {
      first.manager.startStuckPodWatchdog({ intervalMs: 1000, thresholdMs: 5000 });
      expect(vi.getTimerCount()).toBe(1);
      second.manager.startStuckPodWatchdog({ intervalMs: 1000, thresholdMs: 5000 });
      expect(vi.getTimerCount()).toBe(2);
      first.manager.stopStuckPodWatchdog();
      expect(vi.getTimerCount()).toBe(1);
      second.manager.stopStuckPodWatchdog();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      first.manager.stopStuckPodWatchdog();
      second.manager.stopStuckPodWatchdog();
      vi.useRealTimers();
    }
  });
  it('creates the five trigger proxies at the actual public call and resolves a later public method replacement', async () => {
    const f = instance();
    const gate = deferred();
    let calls: ValidationWorkflowCalls | undefined;
    f.owners.validationTriggerWorkflow.triggerValidation = function (
      this: ValidationWorkflowCalls,
    ) {
      calls = this;
      return gate.promise;
    };
    const pending = f.manager.triggerValidation('prepare', { force: true });
    if (!calls) throw new Error('Missing actual trigger proxy');
    const replacement = vi.fn<ValidationWorkflowCalls['handleCompletion']>(function (
      this: unknown,
      id,
    ) {
      expect(this).toBe(f.manager);
      expect(id).toBe('prepare');
      return Promise.resolve();
    });
    f.manager.handleCompletion = replacement;
    await calls.handleCompletion('prepare');
    expect(replacement).toHaveBeenCalledOnce();
    gate.resolve();
    await pending;
  });
  it('persists public legacy admission and committed publication through an actual private SQLite reopen', async () => {
    const f = instance(true);
    const profile = f.profiles.get('test-profile');
    const enqueue = vi.spyOn(f.deps, 'enqueueSession');
    const manager = createPodManager(f.deps);
    let id = '';
    f.db.transaction(() => {
      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Final facade metadata',
          handoffInstructions: '  retained  ',
        },
        'operator',
        { name: 'Owner' },
      );
      id = pod.id;
      expect(enqueue).not.toHaveBeenCalled();
    })();
    await flushAdmission();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(id);
    const saved = manager.getSession(id);
    expect(saved).toMatchObject({ creatorName: 'Owner', handoffInstructions: 'retained' });
    const next = f.reopen();
    expect(next.pods.getOrThrow(id)).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('admits and reopens the actual frozen native configuration through the final composed API after preset edits', async () => {
    const f = instance(true);
    const n = await f.native();
    const launch = f.live.launchConfiguration;
    if (!launch) throw new Error('Missing native setup');
    const manager = createPodManager({
      ...f.deps,
      enqueueSession: f.enqueueSession,
      launchConfiguration: {
        read: launch.read,
        executionSettings: launch.executionSettings,
        assertCurrentCapabilities: launch.assertCurrentCapabilities,
        credentials: launch.credentials,
        prepareEnvironment: async () => 'synthetic-image',
      },
    });
    const create = manager.createResolvedSession;
    if (!create) throw new Error('Missing native facade');
    const admitted = n.snapshots.admit({
      config: n.config,
      requestDigest: n.config.digest,
      createPod: () => create.call(manager, n.config, 'operator').id,
    });
    expect(f.enqueueSession).not.toHaveBeenCalled();
    await flushAdmission();
    expect(f.enqueueSession).toHaveBeenCalledExactlyOnceWith(admitted.podId);
    const flow = n.store.get('workflow', 'flow');
    n.store.write({
      kind: 'workflow',
      id: flow.id,
      name: flow.name,
      expectedRevision: flow.revision,
      payload: { ...flow.payload, branchPrefix: 'edited/' },
    });
    const saved = manager.getSession(admitted.podId);
    expect(manager.getLaunchConfiguration?.(saved.id)).toEqual(n.config);
    const next = f.reopen();
    expect(next.pods.getOrThrow(saved.id)).toEqual(saved);
    expect(
      createLaunchSnapshotRepository(f.db, createConfigurationStore(f.db)).get(saved.id),
    ).toEqual(n.config);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
