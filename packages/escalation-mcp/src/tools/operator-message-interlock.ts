import type { PodBridge } from '../pod-bridge.js';

export interface OperatorMessageInterruption {
  interrupted: true;
  interruptedTool: string;
  operatorMessages: string[];
  instruction: string;
}

export function consumeOperatorMessages(
  podId: string,
  tool: string,
  bridge: PodBridge,
): OperatorMessageInterruption | null {
  const operatorMessages = bridge.consumeMessageBatch?.(podId) ?? [];
  if (operatorMessages.length === 0) return null;
  return {
    interrupted: true,
    interruptedTool: tool,
    operatorMessages,
    instruction:
      'Apply all operator guidance before deciding whether to retry the interrupted tool.',
  };
}

export function stringifyOperatorInterruption(interruption: OperatorMessageInterruption): string {
  return JSON.stringify(interruption, null, 2);
}
