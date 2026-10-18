import { createHash } from 'node:crypto';
import type { AgentEvent, PhaseTokenUsage, Pod } from '@autopod/shared';
import type { EventRepository } from './event-repository.js';

export function deriveAgentAttempt(phaseTokenUsage: PhaseTokenUsage | null): number {
  if (!phaseTokenUsage || !('agent_initial' in phaseTokenUsage)) return 0;
  let highestRework = 0;
  for (const key of Object.keys(phaseTokenUsage)) {
    if (key.startsWith('agent_rework_')) {
      const n = Number.parseInt(key.slice('agent_rework_'.length), 10);
      if (n > highestRework) highestRework = n;
    }
  }
  return 1 + highestRework;
}

export function agentPhaseBucketKey(attempt: number): 'agent_initial' | `agent_rework_${number}` {
  return attempt === 0 ? 'agent_initial' : `agent_rework_${attempt}`;
}

export function hasLatestPersistedAgentTerminalEventComplete(
  eventRepo: EventRepository | undefined,
  podId: string,
  afterEventId = 0,
): boolean {
  if (!eventRepo) return false;
  let latestTerminalEvent: 'complete' | 'error' | null = null;
  let terminalEventId = 0;
  for (const event of eventRepo.getForSession(podId)) {
    if (event.payload.type !== 'pod.agent_activity') continue;
    const agentEvent = event.payload.event;
    if (agentEvent.type === 'complete') {
      latestTerminalEvent = 'complete';
      terminalEventId = event.id;
    } else if (agentEvent.type === 'error' && agentEvent.fatal) {
      latestTerminalEvent = 'error';
    }
  }
  return latestTerminalEvent === 'complete' && terminalEventId > afterEventId;
}

export function agentCompleteEventKey(event: Extract<AgentEvent, { type: 'complete' }>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        timestamp: event.timestamp,
        result: event.result,
        totalInputTokens: event.totalInputTokens ?? null,
        totalOutputTokens: event.totalOutputTokens ?? null,
        cachedInputTokens: event.cachedInputTokens ?? null,
        cacheCreationInputTokens: event.cacheCreationInputTokens ?? null,
        costUsd: event.costUsd ?? null,
      }),
    )
    .digest('hex');
}

export function persistedAgentCompleteEventKeys(
  eventRepo: EventRepository | undefined,
  podId: string,
): Set<string> {
  const keys = new Set<string>();
  if (!eventRepo) return keys;
  for (const event of eventRepo.getForSession(podId, { type: 'pod.agent_activity' })) {
    if (event.payload.type !== 'pod.agent_activity') continue;
    const agentEvent = event.payload.event;
    if (agentEvent.type === 'complete') {
      keys.add(agentCompleteEventKey(agentEvent));
    }
  }
  return keys;
}

export function hasAlreadyCountedCompleteEvent(
  pod: Pod,
  attempt: number,
  event: Extract<AgentEvent, { type: 'complete' }>,
): boolean {
  const inputTokens = event.totalInputTokens ?? 0;
  const outputTokens = event.totalOutputTokens ?? 0;
  const hasTokenTelemetry =
    event.totalInputTokens !== undefined || event.totalOutputTokens !== undefined;
  const bucket = pod.phaseTokenUsage?.[agentPhaseBucketKey(attempt)];
  const tokensAlreadyCounted =
    !hasTokenTelemetry ||
    ((bucket?.inputTokens ?? 0) >= inputTokens && (bucket?.outputTokens ?? 0) >= outputTokens);
  const costAlreadyCounted = event.costUsd === undefined || pod.costUsd >= event.costUsd;
  return tokensAlreadyCounted && costAlreadyCounted;
}
