import type { MemoryScope } from '@autopod/shared';
import type { SessionBridge } from '../session-bridge.js';

export async function memorySuggest(
  sessionId: string,
  input: { scope: MemoryScope; path: string; content: string; rationale?: string },
  bridge: SessionBridge,
): Promise<string> {
  const id = bridge.suggestMemory(
    sessionId,
    input.scope,
    input.path,
    input.content,
    input.rationale,
  );
  const rationaleNote = input.rationale
    ? ''
    : '\nNote: no rationale provided. Suggestions without rationale are harder to approve.';
  return `Memory suggestion submitted for human review (id: ${id})\nScope: ${input.scope}\nPath: ${input.path}${rationaleNote}`;
}
