import type { ReferencePreviewResponse } from '@autopod/shared';
import type { PodBridge } from '../pod-bridge.js';
import {
  consumeOperatorMessages,
  stringifyOperatorInterruption,
} from './operator-message-interlock.js';

export async function renderReference(
  podId: string,
  input: { path: string },
  bridge: PodBridge,
): Promise<ReferencePreviewResponse | string> {
  const interruption = consumeOperatorMessages(podId, 'render_reference', bridge);
  if (interruption) return stringifyOperatorInterruption(interruption);
  if (!bridge.renderReference) throw new Error('Isolated reference rendering is unavailable');
  return bridge.renderReference(podId, input.path);
}
