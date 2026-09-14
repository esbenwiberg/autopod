import type {
  EffectiveLaunchConfig,
  ExecutionProvenance,
  GoalAttemptFence,
  NativeGoalProcessHooks,
  NativeGoalSession,
  Pod,
  PodGoal,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from '../configuration/configuration-store.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { inspectNativeGoal } from '../runtimes/inspect-native-goal.js';
import { nativeGoalCapability } from '../runtimes/native-goal-capability.js';
import { GoalController } from './goal-controller.js';
import { type GoalProcessOwner, createGoalProcessRepository } from './goal-process-repository.js';
import { createGoalRepository } from './goal-repository.js';
import type { PodRepository } from './pod-repository.js';

export interface PodGoalServiceOptions {
  db: Database.Database;
  pods: PodRepository;
  evidence: readonly unknown[];
  assertAllowed(config: EffectiveLaunchConfig): Promise<void>;
  assertCurrent(config: EffectiveLaunchConfig): void;
  publish(goal: PodGoal): void;
  recovery?: {
    readConfig(podId: string): EffectiveLaunchConfig | null;
    manager: ContainerManager;
    inspect?: typeof inspectNativeGoal;
  };
}

/** Connects native continuation to the durable task budget and one pod execution owner. */
export function createPodGoalService(options: PodGoalServiceOptions) {
  const repository = createGoalRepository(options.db);
  const processes = createGoalProcessRepository(options.db);
  function processOwner(podId: string, config: EffectiveLaunchConfig): GoalProcessOwner {
    const pod = options.pods.getOrThrow(podId);
    const goal = repository.get(podId);
    if (
      !goal?.fence ||
      !pod.containerId ||
      !pod.providerAccountIdSnapshot ||
      pod.launchConfigDigest !== config.digest ||
      goal.executionStopped
    )
      configurationError('Native Goal process owner is unavailable', 'GOAL_SUPERSEDED', 409);
    return {
      podId,
      fence: goal.fence,
      configurationDigest: config.digest,
      accountId: pod.providerAccountIdSnapshot,
      containerId: pod.containerId,
    };
  }
  const owners = new Map<
    string,
    { config: EffectiveLaunchConfig; assertCurrent(): void; onState?(goal: PodGoal): void }
  >();
  const controller = new GoalController(repository, {
    confirmProcessStopped(podId) {
      if (!options.db.prepare('SELECT 1 FROM pod_goal_processes WHERE pod_id=? LIMIT 1').get(podId))
        return;
      const config = owners.get(podId)?.config;
      if (!config) configurationError('Native Goal owner changed', 'GOAL_SUPERSEDED', 409);
      const owner = processOwner(podId, config);
      for (const process of processes.list(owner)) {
        if (!process.stoppedAt) processes.confirmStopped(owner, process.execId, null);
      }
    },
    assertCurrent(podId, fence) {
      const owner = owners.get(podId);
      if (!owner || options.pods.getOrThrow(podId).lifecycleGeneration !== fence.generation)
        configurationError('Native Goal execution owner changed', 'GOAL_SUPERSEDED', 409);
      owner.assertCurrent();
      options.assertCurrent(owner.config);
    },
    account(goal) {
      if (!options.pods.taskExecutions)
        configurationError(
          'Native Goals require durable task accounting',
          'TASK_BUDGET_UNAVAILABLE',
          503,
        );
      const usage = options.pods.taskExecutions.snapshot(goal.podId);
      const total =
        usage.recordedTotalTokens ?? usage.recordedInputTokens + usage.recordedOutputTokens;
      return usage.tokenBudget === null ? null : Math.max(0, usage.tokenBudget - total);
    },
    publish(goal) {
      options.publish(goal);
      owners.get(goal.podId)?.onState?.(goal);
    },
  });
  const recovering = new Set<string>();
  async function recover(podId: string): Promise<PodGoal> {
    if (owners.has(podId) || recovering.has(podId))
      configurationError('Native Goal already has an execution owner', 'GOAL_ALREADY_RUNNING', 409);
    const goal = repository.get(podId);
    if (!goal) configurationError('Pod Goal is unavailable', 'GOAL_NOT_FOUND', 404);
    if (goal.executionStopped) {
      // The controller can confirm stop just before the outer task runner settles.
      // A crash in that window must not strand a completed/paused attempt forever.
      if (
        goal.fence &&
        options.db
          .prepare(
            'SELECT 1 FROM task_agent_runs WHERE id=? AND pod_id=? AND generation=? AND ended_at IS NULL',
          )
          .get(goal.fence.attemptId, podId, goal.fence.generation)
      ) {
        if (!options.pods.taskExecutions)
          configurationError(
            'Native Goal accounting is unavailable',
            'TASK_BUDGET_UNAVAILABLE',
            503,
          );
        options.pods.taskExecutions.reconcileNativeGoalRun(goal.fence.attemptId);
      }
      return goal;
    }
    const recovery = options.recovery;
    const config = recovery?.readConfig(podId);
    if (!recovery || !config || !recovery.manager.terminateRecordedExec)
      configurationError(
        'Native Goal recovery is unavailable',
        'GOAL_RECONCILIATION_REQUIRED',
        409,
      );
    const owner = processOwner(podId, config);
    recovering.add(podId);
    try {
      const records = processes.list(owner);
      if (!records.length)
        configurationError(
          'Native process identity is missing; backend reconciliation is required',
          'GOAL_RECONCILIATION_REQUIRED',
          409,
        );
      for (const record of records) {
        if (record.stoppedAt) continue;
        const exitCode = await recovery.manager.terminateRecordedExec(record);
        // Recovery has no live in-process starter: an exact backend identity plus an observed
        // exit closes the create-before-start-acknowledgement crash window as well.
        processes.confirmStopped(owner, record.execId, exitCode);
      }
      const current = repository.get(podId);
      if (!current) configurationError('Pod Goal is unavailable', 'GOAL_NOT_FOUND', 404);
      if (!current.controlIntent) repository.requestControl(podId, current.revision, 'pause');
      if (current.nativeSessionId) {
        const inspect = recovery.inspect ?? inspectNativeGoal;
        await inspect({
          manager: recovery.manager,
          containerId: owner.containerId,
          sessionId: current.nativeSessionId,
          hooks: {
            processCreated(identity) {
              processes.record(owner, identity, 'inspection');
            },
            processStarted(identity) {
              processes.confirmStarted(owner, identity.execId);
            },
          },
          observe(observation) {
            repository.reconcileObservation(podId, owner.fence, observation);
          },
        });
        // The inspection adapter returns only after confirming its own process exit.
        for (const record of processes.list(owner))
          if (!record.stoppedAt) processes.confirmStopped(owner, record.execId, null);
      }
      // With no bound session, the controller could not yet call native Goal start.
      return options.db.transaction(() => {
        if (processes.list(owner).some((record) => !record.stoppedAt))
          configurationError(
            'Native process termination is unconfirmed',
            'GOAL_TERMINATION_UNCONFIRMED',
            409,
          );
        const stopped = repository.confirmStopped(podId, owner.fence);
        if (!options.pods.taskExecutions)
          configurationError(
            'Native Goal accounting is unavailable',
            'TASK_BUDGET_UNAVAILABLE',
            503,
          );
        options.pods.taskExecutions.snapshot(podId);
        options.pods.taskExecutions.reconcileNativeGoalRun(owner.fence.attemptId);
        return stopped;
      })();
    } finally {
      recovering.delete(podId);
      const current = repository.get(podId);
      if (current) options.publish(current);
    }
  }
  return {
    recover,
    get: repository.get,
    processHooks(podId: string, config: EffectiveLaunchConfig): NativeGoalProcessHooks {
      return {
        processCreated(identity) {
          const owner = owners.get(podId);
          if (!owner || owner.config.digest !== config.digest)
            configurationError('Native Goal process has no admitted owner', 'GOAL_SUPERSEDED', 409);
          owner.assertCurrent();
          options.assertCurrent(config);
          processes.record(processOwner(podId, config), identity, 'agent');
        },
        processStarted(identity) {
          processes.confirmStarted(processOwner(podId, config), identity.execId);
        },
      };
    },
    prepareResume(podId: string, revision: number) {
      return repository.requestControl(podId, revision, 'resume');
    },
    initialize(pod: Pod, config: EffectiveLaunchConfig) {
      if (config.intent !== 'goal') return;
      if (pod.runtime !== 'codex')
        configurationError(
          'This runtime has no verified native Goal adapter',
          'GOAL_UNAVAILABLE',
          409,
        );
      repository.create(pod.id, config.task, pod.runtime);
    },
    async run(input: {
      pod: Pod;
      config: EffectiveLaunchConfig;
      provenance: ExecutionProvenance;
      fence: GoalAttemptFence;
      session: NativeGoalSession;
      assertCurrent(): void;
      onState?(goal: PodGoal): void;
    }): Promise<PodGoal> {
      const { pod, config, provenance, fence, session } = input;
      const capability = nativeGoalCapability(
        {
          runtime: pod.runtime,
          runtimeVersion: provenance.cliVersion ?? '',
          imageDigest: provenance.imageDigest ?? '',
          backend: pod.executionTarget,
          providerId: pod.providerIdSnapshot ?? '',
        },
        options.evidence,
      );
      if (
        !capability.available ||
        pod.runtime !== 'codex' ||
        provenance.status !== 'checked' ||
        provenance.podId !== pod.id ||
        provenance.generation !== fence.generation ||
        provenance.runtime !== pod.runtime ||
        provenance.model !== pod.model ||
        provenance.providerId !== pod.providerIdSnapshot ||
        provenance.providerAccountId !== pod.providerAccountIdSnapshot ||
        config.intent !== 'goal' ||
        session.runtime !== pod.runtime
      )
        configurationError(
          'Native Goal capability is unverified for this execution',
          'GOAL_UNAVAILABLE',
          409,
        );
      input.assertCurrent();
      await options.assertAllowed(config);
      input.assertCurrent();
      if (
        !options.db
          .prepare(
            'SELECT 1 FROM task_agent_runs WHERE id=? AND pod_id=? AND generation=? AND ended_at IS NULL',
          )
          .get(fence.attemptId, pod.id, fence.generation)
      )
        configurationError(
          'Native Goal requires an active durable task attempt',
          'GOAL_ATTEMPT_MISSING',
          409,
        );
      if (owners.has(pod.id))
        configurationError('Native Goal is already running', 'GOAL_ALREADY_RUNNING', 409);
      if (recovering.has(pod.id))
        configurationError('Native Goal recovery is active', 'GOAL_ALREADY_RUNNING', 409);
      const goal = repository.get(pod.id);
      if (!goal || goal.objective !== config.task)
        configurationError(
          'Native Goal does not match the frozen launch',
          'GOAL_SESSION_MISMATCH',
          409,
        );
      const owner = { config, assertCurrent: input.assertCurrent, onState: input.onState };
      owners.set(pod.id, owner);
      let stopping = false;
      const watch = setInterval(() => {
        if (stopping) return;
        try {
          owner.assertCurrent();
          options.assertCurrent(config);
        } catch {
          stopping = true;
          const current = repository.get(pod.id);
          if (current)
            void controller.control(pod.id, current.revision, 'pause').catch(() => {
              // Controller retains unconfirmed termination; no second native process may start.
            });
        }
      }, 1000);
      try {
        return await controller.run(pod.id, goal.revision, fence, session);
      } finally {
        clearInterval(watch);
        if (repository.get(pod.id)?.executionStopped && owners.get(pod.id) === owner)
          owners.delete(pod.id);
      }
    },
    async control(podId: string, intent: 'pause' | 'cancel', revision?: number) {
      const goal = repository.get(podId);
      if (!goal) configurationError('Pod Goal is unavailable', 'GOAL_NOT_FOUND', 404);
      if (revision !== undefined && goal.revision !== revision)
        configurationError('Goal changed before control', 'GOAL_CHANGED', 409);
      if (goal.executionStopped && (goal.state === 'achieved' || goal.state === 'cancelled'))
        return goal;
      if (!owners.has(podId) && !goal.executionStopped) {
        repository.requestControl(podId, goal.revision, intent);
        return recover(podId);
      }
      const current = await controller.control(podId, goal.revision, intent);
      if (current.executionStopped) owners.delete(podId);
      return current;
    },
  };
}

export type PodGoalService = ReturnType<typeof createPodGoalService>;
