import { AutopodError } from '@autopod/shared';
import { buildSupervisorCommand, parseStatus } from './preview-supervisor.js';
import type { ResourcePreviewControlsCaptured } from './resource-contracts.js';
import { CONTAINER_APP_PORT } from './resource-policy.js';
import { captureValidationMutationGuard } from './validation-recovery-policy.js';

export function createResourcePreviewControls(captured: ResourcePreviewControlsCaptured) {
  const {
    podRepo,
    containerManagerFactory,
    executionForPod,
    ensureSandboxPreviewProxy,
    schedulePreviewAutoStop,
    logger,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
  } = captured;

  async function startPreview(podId: string): Promise<{ previewUrl: string }> {
    podRepo.deletionOwnership?.assertTaskAvailable(podId);
    const pod = podRepo.getOrThrow(podId);
    const assertCurrent = captureValidationMutationGuard(podRepo, pod);

    if (!pod.containerId) {
      throw new AutopodError(
        `Pod ${podId} has no container — cannot start preview`,
        'INVALID_STATE',
        409,
      );
    }

    const retainedContainerId = pod.containerId;
    if (!pod.previewUrl && pod.executionTarget !== 'sandbox') {
      throw new AutopodError(`Pod ${podId} has no preview URL`, 'INVALID_STATE', 409);
    }

    const cm = containerManagerFactory.get(pod.executionTarget);
    const status = await cm.getStatus(pod.containerId);
    assertCurrent();

    if (status === 'unknown') {
      throw new AutopodError(
        `Container for pod ${podId} has been removed — cannot start preview`,
        'INVALID_STATE',
        409,
      );
    }

    const profile = executionForPod(pod);

    if (status === 'running') {
      // Container is running. Check if the supervisor is already alive — if so
      // return immediately without re-spawning (idempotent against a second
      // startPreview call while validation is running the supervisor).
      if (profile.startCommand) {
        const supervisorAlive = await (async () => {
          try {
            const pidResult = await cm.execInContainer(
              retainedContainerId,
              ['sh', '-c', 'cat /tmp/autopod-supervisor.pid 2>/dev/null'],
              { assertCurrent },
            );
            assertCurrent();
            const pid = pidResult.stdout.trim();
            if (!pid) return false;
            const liveness = await cm.execInContainer(
              retainedContainerId,
              ['sh', '-c', `kill -0 ${pid} 2>/dev/null && echo 1 || echo 0`],
              { assertCurrent },
            );
            assertCurrent();
            return liveness.stdout.trim() === '1';
          } catch {
            return false;
          }
        })();

        assertCurrent();
        if (supervisorAlive) {
          const previewUrl =
            pod.executionTarget === 'sandbox'
              ? await ensureSandboxPreviewProxy(pod)
              : // biome-ignore lint/style/noNonNullAssertion: checked above for local pods
                pod.previewUrl!;
          assertCurrent();
          schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
          logger.info({ podId }, 'Supervisor already running — reusing existing preview');
          return { previewUrl };
        }

        assertCurrent();
        // Supervisor is dead — (re)spawn it
        cm.execInContainer(
          pod.containerId,
          ['sh', '-c', buildSupervisorCommand(profile.startCommand)],
          { cwd: '/workspace', assertCurrent },
        ).catch((err) => {
          logger.warn({ err, podId }, 'Preview supervisor start errored');
        });
      }

      const previewUrl =
        pod.executionTarget === 'sandbox'
          ? await ensureSandboxPreviewProxy(pod)
          : // biome-ignore lint/style/noNonNullAssertion: checked above for local pods
            pod.previewUrl!;
      assertCurrent();
      schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
      logger.info({ podId, previewUrl }, 'Preview started');
      return { previewUrl };
    }

    // Container is stopped — start it
    assertCurrent();
    await cm.start(pod.containerId, { assertCurrent });
    assertCurrent();
    const previewUrl =
      pod.executionTarget === 'sandbox'
        ? await ensureSandboxPreviewProxy(pod)
        : // biome-ignore lint/style/noNonNullAssertion: checked above for local pods
          pod.previewUrl!;

    // Re-run the start command under the supervisor and wait for health check
    if (profile.startCommand) {
      assertCurrent();
      cm.execInContainer(
        pod.containerId,
        ['sh', '-c', buildSupervisorCommand(profile.startCommand)],
        { cwd: '/workspace', assertCurrent },
      ).catch((err) => {
        logger.warn(
          { err, podId },
          'Preview supervisor start command errored (may be expected for long-running processes)',
        );
      });

      // Poll for health
      const healthUrl = previewUrl + profile.healthPath;
      const timeoutMs = (profile.healthTimeout ?? 30) * 1_000;
      const pollIntervalMs = 2_000;
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        assertCurrent();
        try {
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(5_000),
          });
          if (response.status === 200) {
            logger.info({ podId, healthUrl }, 'Preview health check passed');
            break;
          }
        } catch {
          // Health check not ready yet
        }
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining > 0) {
          await new Promise<void>((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
        }
      }
    }

    assertCurrent();
    schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
    logger.info({ podId, previewUrl }, 'Preview started');
    return { previewUrl };
  }

  async function stopPreview(podId: string): Promise<void> {
    podRepo.deletionOwnership?.assertTaskAvailable(podId);
    const pod = podRepo.getOrThrow(podId);
    const assertCurrent = captureValidationMutationGuard(podRepo, pod);
    clearPreviewTimer(podId);
    await stopSandboxPreviewProxy(podId);
    assertCurrent();

    if (!pod.containerId) {
      throw new AutopodError(
        `Pod ${podId} has no container — cannot stop preview`,
        'INVALID_STATE',
        409,
      );
    }

    const cm = containerManagerFactory.get(pod.executionTarget);
    await cm.stop(pod.containerId);
    logger.info({ podId }, 'Preview stopped');
  }

  async function previewStatus(podId: string): Promise<{
    running: boolean;
    reachable: boolean;
    restartCount: number;
    lastError: string | null;
    previewUrl: string | null;
  }> {
    const pod = podRepo.getOrThrow(podId);
    const assertCurrent = captureValidationMutationGuard(podRepo, pod);
    const safeDefaults = {
      running: false,
      reachable: false,
      restartCount: 0,
      lastError: null,
      previewUrl: pod.previewUrl,
    };

    if (!pod.containerId || (!pod.previewUrl && pod.executionTarget !== 'sandbox')) {
      return safeDefaults;
    }

    const cm = containerManagerFactory.get(pod.executionTarget);

    // If the container is not running, the supervisor is definitely not alive.
    try {
      const containerStatus = await cm.getStatus(pod.containerId);
      assertCurrent();
      if (containerStatus !== 'running') return safeDefaults;
    } catch {
      return safeDefaults;
    }

    const previewUrl =
      pod.executionTarget === 'sandbox'
        ? await ensureSandboxPreviewProxy(pod)
        : // biome-ignore lint/style/noNonNullAssertion: checked before status probe
          pod.previewUrl!;

    // A native sandbox preview URL is Entra-gated, so a host-side fetch just
    // gets 401 — probe the app from inside the container instead (the real
    // liveness signal). The daemon-local proxy URL (127.0.0.1) is fetched
    // directly as before.
    const isNativePreview =
      pod.executionTarget === 'sandbox' && !previewUrl.startsWith('http://127.0.0.1');

    assertCurrent();
    // Exec parallel reads inside the container + an HTTP probe.
    const [pidResult, restartCountResult, logTailResult, httpProbeResult] = await Promise.all([
      cm
        .execInContainer(
          pod.containerId,
          ['sh', '-c', 'cat /tmp/autopod-supervisor.pid 2>/dev/null'],
          { assertCurrent },
        )
        .catch(() => null),
      cm
        .execInContainer(
          pod.containerId,
          ['sh', '-c', 'cat /tmp/autopod-restart-count 2>/dev/null'],
          { assertCurrent },
        )
        .catch(() => null),
      cm
        .execInContainer(
          pod.containerId,
          ['sh', '-c', 'tail -c 200 /tmp/autopod-start.log 2>/dev/null'],
          { assertCurrent },
        )
        .catch(() => null),
      isNativePreview
        ? cm
            .execInContainer(
              pod.containerId,
              [
                'sh',
                '-c',
                // Prefer curl for the exact status code; fall back to wget (treat
                // a 2xx/3xx success as 200) so leaner warm images still probe.
                `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:${CONTAINER_APP_PORT} 2>/dev/null); if [ -n "$code" ] && [ "$code" != "000" ]; then echo "$code"; elif wget -q -T 3 -O /dev/null http://localhost:${CONTAINER_APP_PORT} 2>/dev/null; then echo 200; fi`,
              ],
              { assertCurrent },
            )
            .then((r) => {
              const code = Number.parseInt(r.stdout.trim(), 10);
              return Number.isFinite(code) && code > 0 ? code : null;
            })
            .catch(() => null)
        : fetch(previewUrl, { signal: AbortSignal.timeout(3_000) })
            .then((r) => r.status)
            .catch(() => null),
    ]);

    assertCurrent();
    // Check PID liveness: if we got a PID string, verify the process is still alive.
    const rawPid = pidResult?.stdout?.trim() ?? null;
    let alivePid: string | null = null;
    if (rawPid) {
      try {
        const check = await cm.execInContainer(
          pod.containerId,
          ['sh', '-c', `kill -0 ${rawPid} 2>/dev/null && echo 1 || echo 0`],
          { assertCurrent },
        );
        alivePid = check.stdout.trim() === '1' ? rawPid : null;
      } catch {
        alivePid = null;
      }
    }

    const status = parseStatus({
      pid: alivePid,
      restartCount: restartCountResult?.stdout ?? null,
      startLogTail: logTailResult?.stdout ?? null,
      reachableHttp: typeof httpProbeResult === 'number' ? httpProbeResult : null,
    });

    return { ...status, previewUrl };
  }
  return { startPreview, stopPreview, previewStatus };
}
