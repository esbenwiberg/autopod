import { AutopodError } from '@autopod/shared';
import type { OperatorPauseCaptured, OperatorPauseLiveDependencies } from './operator-contracts.js';
import { PAUSE_QUIESCENCE_TIMEOUT_MS } from './operator-state.js';
import { canPause } from './state-machine.js';
export function createOperatorPause(
  deps: OperatorPauseLiveDependencies,
  captured: OperatorPauseCaptured,
) {
  const {
    pauseIntents,
    podRepo,
    emitActivityStatus,
    activeAgentRuns,
    logger,
    runtimeRegistry,
    transition,
  } = captured;
  async function pauseSession(podId: string): Promise<void> {
    if (pauseIntents.has(podId)) {
      throw new AutopodError(`Pod ${podId} pause is already settling`, 'PAUSE_SETTLING', 409);
    }
    const pod = podRepo.getOrThrow(podId);
    if (!canPause(pod.status)) {
      throw new AutopodError(
        `Cannot pause pod ${podId} in status ${pod.status}`,
        'INVALID_STATE',
        409,
      );
    }

    emitActivityStatus(podId, 'Pausing pod…');
    const pauseToken = Symbol(podId);
    pauseIntents.set(podId, pauseToken);
    let activeRun = activeAgentRuns.get(podId);
    const releaseIntentAfterSettling = (message: string): void => {
      if (!activeRun) {
        if (pauseIntents.get(podId) === pauseToken) pauseIntents.delete(podId);
        return;
      }
      void activeRun.settled.then(() => {
        if (pauseIntents.get(podId) !== pauseToken) return;
        pauseIntents.delete(podId);
        emitActivityStatus(podId, message);
        logger.info({ podId }, message);
      });
    };
    // Suspend the runtime (kills stream but preserves pod ID)
    const runtime = runtimeRegistry.get(pod.runtime);
    try {
      if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
        if (!deps.launchConfiguration.goals)
          throw new AutopodError('Native Goal controls are unavailable', 'GOAL_UNAVAILABLE', 503);
        await deps.launchConfiguration.goals.control(podId, 'pause');
      } else await runtime.suspend(podId);
    } catch (err) {
      activeRun = activeAgentRuns.get(podId) ?? activeRun;
      releaseIntentAfterSettling('Failed pause attempt has settled — pause may be retried safely');
      throw err;
    }
    activeRun = activeAgentRuns.get(podId) ?? activeRun;
    const quiescenceDeadline = Date.now() + PAUSE_QUIESCENCE_TIMEOUT_MS;
    while (activeRun) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const remainingMs = Math.max(0, quiescenceDeadline - Date.now());
      const settled = await Promise.race([
        activeRun.settled.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), remainingMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        const message = `Pause quiescence failed: active Codex run did not settle within ${PAUSE_QUIESCENCE_TIMEOUT_MS}ms`;
        emitActivityStatus(podId, message);
        logger.error({ podId }, message);
        releaseIntentAfterSettling(
          'Timed-out pause has now quiesced — pause may be retried safely',
        );
        throw new AutopodError(message, 'PAUSE_QUIESCENCE_TIMEOUT', 409);
      }
      const nextRun = activeAgentRuns.get(podId);
      activeRun = nextRun?.token === activeRun.token ? undefined : nextRun;
    }

    transition(pod, 'paused', { pauseReason: 'manual' });
    if (pauseIntents.get(podId) === pauseToken) pauseIntents.delete(podId);
    emitActivityStatus(podId, 'Pod paused — use [t] tell or [u] nudge to resume');
    logger.info({ podId }, 'Pod paused');
  }
  return { pauseSession };
}
