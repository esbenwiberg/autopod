import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionTarget, Pod, PodOptions } from '@autopod/shared';
import { AutopodError, CONTAINER_HOME_DIR } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { claudeStateDirForPod } from '../runtimes/claude-state-store.js';
import { codexStateDirForPod } from '../runtimes/codex-state-store.js';
import { ProviderAttemptSupersededError } from './provider-attempt-repository.js';
import { POD_ARTIFACTS_CONTAINER_DIR, dataDir, safeFsSegment } from './provisioning-materials.js';
import type { ProvisioningCaptured, ProvisioningLiveDependencies } from './provisioning-ports.js';

type Captured = Pick<ProvisioningCaptured, 'podRepo' | 'containerManagerFactory' | 'logger'>;

export function createProvisioningSandboxState(
  deps: Pick<ProvisioningLiveDependencies, 'sandboxRuntimeSessionSyncTimeoutMs'>,
  captured: Captured,
) {
  const { podRepo, containerManagerFactory, logger } = captured;

  function assertSandboxAgentStreamingExecSupported(
    profile: Pick<PodExecutionSettings, 'name'>,
    executionTarget: ExecutionTarget,
    options: PodOptions,
  ): void {
    if (executionTarget !== 'sandbox' || options.agentMode === 'interactive') return;

    const cm = containerManagerFactory.get('sandbox');
    if (cm.supportsStreamingExec === false) {
      const message = [
        `Sandbox execution for profile "${profile.name}" cannot run agent pods because the`,
        'configured sandbox backend does not support native streaming exec.',
        'Azure Sandboxes currently expose only buffered exec, which is safe for short commands',
        'but not Claude/Codex/Copilot runtimes. Use executionTarget=local for agent pods',
        'until sandbox streaming is available.',
      ].join(' ');
      throw new AutopodError(message, 'UNSUPPORTED_SANDBOX_STREAMING_EXEC', 400);
    }
  }

  async function syncSandboxRuntimeSessionState(pod: Pod, ownsRun: () => boolean): Promise<void> {
    const podId = pod.id;
    if (pod.executionTarget !== 'sandbox' || !pod.containerId) return;

    const statePaths =
      pod.runtime === 'claude'
        ? {
            container: `${CONTAINER_HOME_DIR}/.claude/projects`,
            host: claudeStateDirForPod(podId),
          }
        : pod.runtime === 'codex'
          ? {
              container: `${CONTAINER_HOME_DIR}/.codex/sessions`,
              host: codexStateDirForPod(podId),
            }
          : null;
    if (!statePaths) return;

    const controller = new AbortController();
    const assertCurrent = () => {
      if (!ownsRun()) throw new ProviderAttemptSupersededError();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cm = containerManagerFactory.get(pod.executionTarget);
      const timeoutMs = deps.sandboxRuntimeSessionSyncTimeoutMs ?? 30_000;
      await Promise.race([
        cm.extractDirectoryFromContainer(
          pod.containerId,
          statePaths.container,
          statePaths.host,
          undefined,
          { signal: controller.signal, assertCurrent },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `Sandbox runtime session state sync timed out after ${timeoutMs}ms`,
            );
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      logger.warn(
        { err, podId, runtime: pod.runtime },
        'Failed to sync sandbox runtime session state — future recovery may restart fresh',
      );
    } finally {
      controller.abort();
      if (timer) clearTimeout(timer);
    }
  }

  async function syncSandboxSeriesHandover(podId: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.executionTarget !== 'sandbox' || !pod.seriesId || !pod.containerId) return;

    const handoverFileName = `${safeFsSegment(pod.id)}.md`;
    const containerPath = `${POD_ARTIFACTS_CONTAINER_DIR}/handovers/${handoverFileName}`;
    const hostPath = path.join(
      dataDir(),
      'pod-artifacts',
      safeFsSegment(pod.seriesId),
      'handovers',
      handoverFileName,
    );

    const cm = containerManagerFactory.get(pod.executionTarget);
    let content: string;
    try {
      content = await cm.readFile(pod.containerId, containerPath);
    } catch (err) {
      logger.warn(
        { err, podId, seriesId: pod.seriesId, containerPath },
        'Sandbox series handover missing or unreadable — continuing without it',
      );
      return;
    }

    await mkdir(path.dirname(hostPath), { recursive: true });
    await writeFile(hostPath, content, 'utf8');
    logger.info({ podId, seriesId: pod.seriesId, hostPath }, 'Sandbox series handover synced');
  }

  return {
    assertSandboxAgentStreamingExecSupported,
    syncSandboxRuntimeSessionState,
    syncSandboxSeriesHandover,
  };
}
