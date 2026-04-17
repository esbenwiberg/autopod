import type { PodBridge } from '../pod-bridge.js';

export async function checkMessages(podId: string, bridge: PodBridge): Promise<string> {
  const result = bridge.consumeMessages(podId);
  if (result.hasMessage) {
    return JSON.stringify({ hasMessage: true, message: result.message });
  }
  return JSON.stringify({ hasMessage: false });
}
