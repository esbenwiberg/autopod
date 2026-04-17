import type { MemoryScope } from '@autopod/shared';
import type { PodBridge } from '../pod-bridge.js';

export async function memorySearch(
  podId: string,
  input: { query: string; scope: MemoryScope },
  bridge: PodBridge,
): Promise<string> {
  const entries = bridge.searchMemories(podId, input.scope, input.query);
  if (entries.length === 0) {
    return `No memories matching "${input.query}" in scope: ${input.scope}`;
  }
  const rows = entries.map((e) => {
    const preview = e.content.slice(0, 120).replace(/\n/g, ' ');
    return `- **${e.path}** (id: ${e.id})\n  ${preview}${e.content.length > 120 ? '...' : ''}`;
  });
  return `## Search results for "${input.query}" (${input.scope})\n\n${rows.join('\n')}`;
}
