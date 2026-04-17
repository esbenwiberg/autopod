import type { PodBridge } from '../pod-bridge.js';

export async function memoryRead(
  podId: string,
  input: { id: string },
  bridge: PodBridge,
): Promise<string> {
  const entry = bridge.readMemory(podId, input.id);
  const whyLine = entry.rationale ? `**Why:** ${entry.rationale}\n\n` : '';
  return `## ${entry.path}\n\n${whyLine}${entry.content}\n\n---\n_Scope: ${entry.scope}, version: ${entry.version}_`;
}
