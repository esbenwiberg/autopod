import type { MemoryScope } from '@autopod/shared';
import type { PodBridge } from '../pod-bridge.js';

export async function memorySuggest(
  podId: string,
  input: { scope: MemoryScope; path: string; content: string; rationale?: string },
  bridge: PodBridge,
): Promise<string> {
  const id = bridge.suggestMemory(
    podId,
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
