import { type AgentCompleteEvent, type AgentUsageEvent, AutopodError } from '@autopod/shared';

type Usage = Pick<
  AgentCompleteEvent,
  | 'totalInputTokens'
  | 'totalOutputTokens'
  | 'cachedInputTokens'
  | 'cacheCreationInputTokens'
  | 'costUsd'
>;

/** One consumer owns these invocation cursors; persisted pod/provider totals remain authoritative. */
export function createRuntimeUsageCounter() {
  const segments = new Map<string, Usage>();
  const settled = new Set<string>();
  const sequences = new Map<string, number>();
  const consume = (event: AgentUsageEvent | AgentCompleteEvent): Usage => {
    const incoming: Usage = {
      totalInputTokens: event.totalInputTokens,
      totalOutputTokens: event.totalOutputTokens,
      cachedInputTokens: event.cachedInputTokens,
      cacheCreationInputTokens:
        event.type === 'complete' ? event.cacheCreationInputTokens : undefined,
      costUsd: event.costUsd,
    };
    const previous = event.usageSegmentId ? segments.get(event.usageSegmentId) : undefined;
    if (event.type === 'usage') {
      const priorSequence = sequences.get(event.usageSegmentId);
      if (
        !Number.isSafeInteger(event.usageSequence) ||
        event.usageSequence < 1 ||
        (priorSequence !== undefined &&
          (event.usageSequence < priorSequence ||
            (event.usageSequence === priorSequence &&
              (Object.keys(incoming) as (keyof Usage)[]).some(
                (key) => incoming[key] !== previous?.[key],
              ))))
      )
        throw new AutopodError('Conflicting runtime usage sequence', 'RUNTIME_USAGE_CONFLICT', 409);
    }
    const delta: Usage = {};
    for (const key of Object.keys(incoming) as Array<keyof Usage>) {
      const value = incoming[key];
      if (value === undefined) continue;
      const before = previous?.[key] ?? 0;
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (key !== 'costUsd' && !Number.isSafeInteger(value)) ||
        value + (key === 'costUsd' ? 1e-9 : 0) < before
      )
        throw new AutopodError(
          'Runtime usage counters are invalid or regressed; retain observed usage and reconcile native evidence.',
          'RUNTIME_USAGE_CONFLICT',
          409,
        );
      delta[key] = Math.max(0, value - before);
    }
    if (
      (incoming.cachedInputTokens ?? 0) + (incoming.cacheCreationInputTokens ?? 0) >
      (incoming.totalInputTokens ?? Number.POSITIVE_INFINITY)
    )
      throw new AutopodError('Runtime cache usage exceeds input', 'RUNTIME_USAGE_CONFLICT', 409);
    if (event.usageSegmentId)
      segments.set(event.usageSegmentId, {
        ...previous,
        ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)),
      });
    if (event.type === 'usage') sequences.set(event.usageSegmentId, event.usageSequence);
    if (event.type === 'complete' && event.usageSegmentId) settled.add(event.usageSegmentId);
    return delta;
  };
  return Object.assign(consume, {
    hasUnsettledSegments: () => [...segments.keys()].some((id) => !settled.has(id)),
  });
}
