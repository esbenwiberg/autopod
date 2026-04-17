import type { MemoryScope } from '@autopod/shared';
import type { PodBridge } from '../pod-bridge.js';

export async function memoryList(
  podId: string,
  input: { scope: MemoryScope },
  bridge: PodBridge,
): Promise<string> {
  const entries = bridge.listMemories(podId, input.scope);
  if (entries.length === 0) {
    return `No approved memories found for scope: ${input.scope}`;
  }
  const rows = entries.map((e) => {
    const preview = e.content.slice(0, 100).replace(/\n/g, ' ');
    return `- **${e.path}** (id: ${e.id})\n  ${preview}${e.content.length > 100 ? '...' : ''}`;
  });
  return `## Memories (${input.scope})\n\n${rows.join('\n')}`;
}
