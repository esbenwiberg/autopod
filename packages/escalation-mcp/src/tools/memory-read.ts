import type { SessionBridge } from '../session-bridge.js';

export async function memoryRead(
  sessionId: string,
  input: { id: string },
  bridge: SessionBridge,
): Promise<string> {
  const entry = bridge.readMemory(sessionId, input.id);
  return `## ${entry.path}\n\n${entry.content}\n\n---\n_Scope: ${entry.scope}, version: ${entry.version}_`;
}
