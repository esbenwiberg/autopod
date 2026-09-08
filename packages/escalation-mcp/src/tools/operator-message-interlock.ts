import type { PodBridge } from '../pod-bridge.js';

export interface OperatorMessageInterruption {
  interrupted: true;
  interruptedTool: string;
  operatorMessages: string[];
  instruction: string;
  deliveryId: string;
}

export function consumeOperatorMessages(
  podId: string,
  tool: string,
  bridge: PodBridge,
): OperatorMessageInterruption | null {
  const delivery = bridge.readOperatorGuidance(podId);
  if (!delivery) return null;
  const operatorMessages = delivery.messages;
  return {
    interrupted: true,
    interruptedTool: tool,
    operatorMessages,
    deliveryId: delivery.deliveryId,
    instruction:
      'After receiving these complete messages, call acknowledge_messages with this deliveryId. Apply all guidance before deciding whether to retry the interrupted tool. Acknowledgment does not approve a decision or resume execution.',
  };
}

export function stringifyOperatorInterruption(interruption: OperatorMessageInterruption): string {
  return JSON.stringify(interruption, null, 2);
}
