import type { SessionBridge } from '../session-bridge.js';

export async function memoryRead(
  sessionId: string,
  input: { id: string },
  bridge: SessionBridge,
): Promise<string> {
  const entry = bridge.readMemory(sessionId, input.id);
  const whyLine = entry.rationale ? `**Why:** ${entry.rationale}\n\n` : '';
  return `## ${entry.path}\n\n${whyLine}${entry.content}\n\n---\n_Scope: ${entry.scope}, version: ${entry.version}_`;
}
