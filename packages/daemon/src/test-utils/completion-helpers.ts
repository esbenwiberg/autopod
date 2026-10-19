import { vi } from 'vitest';
import { createAgentActivity } from '../pods/agent-activity.js';
import { createCompletionDiagnostics } from '../pods/completion-diagnostics.js';
import { createCompletionEvents } from '../pods/completion-events.js';
import { createCompletionGuards } from '../pods/completion-guards.js';
import type {
  CompletionOwnersCaptured,
  CompletionWorkflowCaptured,
} from '../pods/completion-ports.js';
import { createCompletionOwners, createCompletionWorkflow } from '../pods/completion-workflow.js';
import { createProvisioningFixture } from './provisioning-helpers.js';

export function createCompletionFixture(disk = false) {
  const f = createProvisioningFixture(disk);
  const activity = createAgentActivity(f.deps, { podRepo: f.podRepo, logger: f.deps.logger });
  const refreshReadiness = vi.fn(() => true);
  const events = createCompletionEvents({
    podRepo: f.podRepo,
    eventBus: f.deps.eventBus,
    bumpActivityTimestamp: activity.bumpActivityTimestamp,
    recordNotReportedMemoryUsage: activity.recordNotReportedMemoryUsage,
    refreshReadiness,
  });
  const guards = createCompletionGuards({ podRepo: f.podRepo, nudgeRepo: f.deps.nudgeRepo });
  const diagnostics = createCompletionDiagnostics({ emitActivityError: events.emitActivityError });
  const captured = {
    podRepo: f.podRepo,
    nudgeRepo: f.deps.nudgeRepo,
    preservePodWorkspace: vi.fn(async () => {}),
    ownsArtifactCompletion: vi.fn(() => true),
    transition: events.transition,
    logger: f.deps.logger,
    emitActivityStatus: events.emitActivityStatus,
    containerManagerFactory: f.deps.containerManagerFactory,
    worktreeManager: f.worktreeManager,
    checkpointSandboxWorkspaceForPod: vi.fn(async () => {
      throw new Error('Unexpected sandbox checkpoint in local completion fixture');
    }),
    syncSandboxSeriesHandover: f.sandbox.syncSandboxSeriesHandover,
    syncWorkspaceBack: f.captured.syncWorkspaceBack,
    tryRecoverAfterWorkspaceSyncFailure: vi.fn(async () => false),
    recoverWorktreeFromContainer: vi.fn(async () => false),
    parkOnWorktreeSyncFailure: vi.fn(),
    handleDeletionGuardError: vi.fn(() => false),
    executionForPod: f.captured.resolveEffectiveBoundProfile,
    cleanupContainer: vi.fn(async () => {}),
    emitPodCompletedEvent: events.emitPodCompletedEvent,
    maybeTriggerDependents: vi.fn(),
  } satisfies CompletionOwnersCaptured;
  const owners = createCompletionOwners(captured);
  const workflowCaptured = {
    podRepo: f.podRepo,
    ...owners,
    artifactCompletionRuns: new Map<string, Promise<void>>(),
    finalizeArtifactPod: vi.fn(async () => {}),
  } satisfies CompletionWorkflowCaptured;
  const calls = { triggerValidation: vi.fn(async () => {}) };
  return {
    ...f,
    get db() {
      return f.db;
    },
    activity,
    refreshReadiness,
    events,
    guards,
    diagnostics,
    captured,
    owners,
    workflowCaptured,
    calls,
    workflow: () => createCompletionWorkflow(f.deps, workflowCaptured),
    running() {
      f.podRepo.update('prepare', {
        status: 'running',
        containerId: 'container-123',
        worktreePath: f.directory,
      });
      f.podRepo.completionJournal?.begin(f.pod());
    },
  };
}
