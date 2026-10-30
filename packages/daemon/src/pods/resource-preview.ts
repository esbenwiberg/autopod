import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { ResourcePreviewCaptured } from './resource-contracts.js';
import {
  CONTAINER_APP_PORT,
  allocateHostPort,
  nativePreviewEmails,
  parsePreviewPort,
} from './resource-policy.js';
import { type SandboxPreviewProxy, startSandboxPreviewProxy } from './sandbox-preview-proxy.js';
import { captureValidationMutationGuard } from './validation-recovery-policy.js';

export function createResourcePreview(captured: ResourcePreviewCaptured) {
  const { containerManagerFactory, logger, podRepo } = captured;
  const sandboxPreviewProxies = new Map<
    string,
    { containerId: string; proxy: SandboxPreviewProxy; assertCurrent: () => unknown }
  >();
  const nativePreviewPorts = new Map<string, { containerId: string; port: number; url: string }>();
  async function tryNativeSandboxPreview(pod: Pod, containerId: string): Promise<string | null> {
    const assertCurrent = captureValidationMutationGuard(podRepo, pod);
    const emails = nativePreviewEmails();
    if (emails.length === 0) return null;
    const cm = containerManagerFactory.get('sandbox');
    if (!cm.exposePort) return null;

    const cached = nativePreviewPorts.get(pod.id);
    if (cached?.containerId === containerId) return cached.url;
    if (cached) nativePreviewPorts.delete(pod.id);

    try {
      const exposed = await cm.exposePort(containerId, CONTAINER_APP_PORT, { entraEmails: emails });
      assertCurrent();
      if (!exposed.url) {
        logger.warn(
          { podId: pod.id },
          'Native sandbox port exposed but no URL assigned; falling back to preview proxy',
        );
        return null;
      }
      nativePreviewPorts.set(pod.id, { containerId, port: CONTAINER_APP_PORT, url: exposed.url });
      if (pod.previewUrl !== exposed.url) {
        podRepo.update(pod.id, { previewUrl: exposed.url });
      }
      logger.info({ podId: pod.id, url: exposed.url }, 'Native sandbox preview URL exposed');
      return exposed.url;
    } catch (err) {
      logger.warn(
        { err, podId: pod.id },
        'Native sandbox port exposure failed; falling back to preview proxy',
      );
      return null;
    }
  }

  async function ensureSandboxPreviewProxy(pod: Pod): Promise<string> {
    const assertCurrent = captureValidationMutationGuard(podRepo, pod);
    if (pod.executionTarget !== 'sandbox') {
      if (!pod.previewUrl) {
        throw new AutopodError(`Pod ${pod.id} has no preview URL`, 'INVALID_STATE', 409);
      }
      return pod.previewUrl;
    }

    if (!pod.containerId) {
      throw new AutopodError(
        `Pod ${pod.id} has no container — cannot start preview`,
        'INVALID_STATE',
        409,
      );
    }

    // Prefer the platform's native public port when configured; fall back to the
    // daemon-side exec proxy otherwise (or on failure).
    const nativeUrl = await tryNativeSandboxPreview(pod, pod.containerId);
    assertCurrent();
    if (nativeUrl) {
      // A native URL supersedes any previously-started exec proxy for this pod.
      if (sandboxPreviewProxies.has(pod.id)) await stopSandboxPreviewProxy(pod.id);
      return nativeUrl;
    }

    let previewUrl = pod.previewUrl;
    // A stale native URL (native since disabled/failed) must not be reused as a
    // proxy host-port — reset it so a fresh 127.0.0.1 URL is allocated below.
    if (previewUrl && !previewUrl.startsWith('http://127.0.0.1')) {
      previewUrl = null;
    }
    if (!previewUrl) {
      previewUrl = `http://127.0.0.1:${allocateHostPort()}`;
      podRepo.update(pod.id, { previewUrl });
    }

    const existing = sandboxPreviewProxies.get(pod.id);
    if (existing?.containerId === pod.containerId) {
      try {
        existing.assertCurrent();
        return existing.proxy.url;
      } catch {
        // The new snapshot was checked above. Retire a proxy whose captured
        // status/configuration/generation is stale; never reuse its old guard.
      }
    }
    if (existing) await stopSandboxPreviewProxy(pod.id);

    const hostPort = parsePreviewPort(previewUrl);
    if (!hostPort) {
      throw new AutopodError(`Pod ${pod.id} has invalid preview URL`, 'INVALID_STATE', 409);
    }

    assertCurrent();
    const proxy = await startSandboxPreviewProxy({
      assertCurrent,
      podId: pod.id,
      containerId: pod.containerId,
      hostPort,
      containerPort: CONTAINER_APP_PORT,
      containerManager: containerManagerFactory.get('sandbox'),
      logger,
    });
    assertCurrent();
    sandboxPreviewProxies.set(pod.id, { containerId: pod.containerId, proxy, assertCurrent });
    if (proxy.url !== previewUrl) {
      podRepo.update(pod.id, { previewUrl: proxy.url });
    }
    return proxy.url;
  }

  async function stopSandboxPreviewProxy(podId: string): Promise<void> {
    const native = nativePreviewPorts.get(podId);
    if (native) {
      nativePreviewPorts.delete(podId);
      const cm = containerManagerFactory.get('sandbox');
      await cm.unexposePort?.(native.containerId, native.port).catch((err) => {
        logger.warn({ err, podId }, 'Failed to remove native sandbox preview port');
      });
    }
    const existing = sandboxPreviewProxies.get(podId);
    if (!existing) return;
    sandboxPreviewProxies.delete(podId);
    await existing.proxy.close().catch((err) => {
      logger.warn({ err, podId }, 'Failed to close sandbox preview proxy');
    });
  }
  return { tryNativeSandboxPreview, ensureSandboxPreviewProxy, stopSandboxPreviewProxy };
}
