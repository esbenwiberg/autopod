import type { Pod } from '@autopod/shared';
import {
  type HaproxyDenyStreamHandle,
  streamHaproxyDenials,
} from '../containers/haproxy-deny-stream.js';
import type { ResourceDenialsCaptured } from './resource-contracts.js';

export function createResourceDenials(captured: ResourceDenialsCaptured) {
  const { containerManagerFactory, eventBus, logger } = captured;
  const haproxyDenyHandles = new Map<string, HaproxyDenyStreamHandle>();
  async function startHaproxyDenyReceiver(pod: Pod, containerId: string): Promise<void> {
    const cm = containerManagerFactory.get(pod.executionTarget);
    try {
      const handle = await streamHaproxyDenials(
        cm,
        containerId,
        ({ sni, src }) => {
          eventBus.emit({
            type: 'pod.firewall_denied',
            timestamp: new Date().toISOString(),
            podId: pod.id,
            sni,
            src,
          });
        },
        logger,
      );
      haproxyDenyHandles.set(pod.id, handle);
    } catch (err) {
      logger.warn(
        { err, podId: pod.id, containerId },
        'Failed to start HAProxy deny receiver — pod runs without denial visibility',
      );
    }
  }

  async function stopHaproxyDenyReceiver(podId: string): Promise<void> {
    const handle = haproxyDenyHandles.get(podId);
    if (!handle) return;
    haproxyDenyHandles.delete(podId);
    try {
      await handle.stop();
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to stop HAProxy deny receiver');
    }
  }
  return { startHaproxyDenyReceiver, stopHaproxyDenyReceiver };
}
