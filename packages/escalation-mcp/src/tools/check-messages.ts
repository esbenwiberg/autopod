import type { PodBridge } from '../pod-bridge.js';

export async function checkMessages(podId: string, bridge: PodBridge): Promise<string> {
  const delivery = bridge.readOperatorGuidance(podId);
  if (!delivery) return JSON.stringify({ hasMessage: false });
  return JSON.stringify({
    hasMessage: true,
    message: delivery.messages.join('\n\n'),
    operatorMessages: delivery.messages,
    deliveryId: delivery.deliveryId,
    instruction:
      'After receiving these complete messages, call acknowledge_messages with this deliveryId. Apply the guidance before continuing work. Acknowledgment does not approve a decision or resume execution.',
  });
}
