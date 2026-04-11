import type { MemoryScope } from '@autopod/shared';
import type { SessionBridge } from '../session-bridge.js';

export async function memoryList(
  sessionId: string,
  input: { scope: MemoryScope },
  bridge: SessionBridge,
): Promise<string> {
  const entries = bridge.listMemories(sessionId, input.scope);
  if (entries.length === 0) {
    return `No approved memories found for scope: ${input.scope}`;
  }
  const rows = entries.map((e) => {
    const preview = e.content.slice(0, 100).replace(/\n/g, ' ');
    return `- **${e.path}** (id: ${e.id})\n  ${preview}${e.content.length > 100 ? '...' : ''}`;
  });
  return `## Memories (${input.scope})\n\n${rows.join('\n')}`;
}
