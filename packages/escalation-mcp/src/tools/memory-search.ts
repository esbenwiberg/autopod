import type { MemoryScope } from '@autopod/shared';
import type { SessionBridge } from '../session-bridge.js';

export async function memorySearch(
  sessionId: string,
  input: { query: string; scope: MemoryScope },
  bridge: SessionBridge,
): Promise<string> {
  const entries = bridge.searchMemories(sessionId, input.scope, input.query);
  if (entries.length === 0) {
    return `No memories matching "${input.query}" in scope: ${input.scope}`;
  }
  const rows = entries.map((e) => {
    const preview = e.content.slice(0, 120).replace(/\n/g, ' ');
    return `- **${e.path}** (id: ${e.id})\n  ${preview}${e.content.length > 120 ? '...' : ''}`;
  });
  return `## Search results for "${input.query}" (${input.scope})\n\n${rows.join('\n')}`;
}
