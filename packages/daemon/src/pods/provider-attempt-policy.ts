import { createHash } from 'node:crypto';
import type { Pod, ReasoningEffort } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';

export function redactedProfileSnapshot(
  pod: Pod,
  profile: PodExecutionSettings,
): Record<string, unknown> {
  const snapshot = pod.profileSnapshot ?? profile;
  const redact = (value: unknown, key = ''): unknown => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes('credential') ||
      normalizedKey.includes('password') ||
      normalizedKey.includes('secret') ||
      normalizedKey.includes('token') ||
      normalizedKey.includes('apikey') ||
      normalizedKey.includes('api_key') ||
      normalizedKey.includes('authorization') ||
      normalizedKey.includes('header') ||
      normalizedKey === 'env' ||
      normalizedKey.endsWith('pat') ||
      normalizedKey === 'auth'
    ) {
      return null;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          redact(childValue, childKey),
        ]),
      );
    }
    if (typeof value === 'string' && value.includes('://')) {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        // Query strings and fragments can carry API keys, signed-URL credentials, and
        // bearer tokens under provider-specific names. They are not execution identity.
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        // Not a URL; preserve ordinary profile text.
      }
    }
    return value;
  };
  return redact(snapshot) as Record<string, unknown>;
}

export function profileReferenceForAttempt(
  pod: Pod,
  redactedSnapshot: Record<string, unknown>,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(redactedSnapshot))
    .digest('hex')
    .slice(0, 16);
  return `pod:${pod.id}@profile-snapshot#${hash}`;
}

export function nativeSessionId(pod: Pod): string | null {
  if (pod.runtime === 'claude') return pod.claudeSessionId;
  if (pod.runtime === 'codex') return pod.codexSessionId;
  if (pod.runtime === 'pi') return pod.piSessionId;
  return null;
}

export function reasoningEffortFromSnapshot(
  snapshot: Record<string, unknown> | null | undefined,
): ReasoningEffort | null {
  const value = snapshot?.reasoningEffort;
  return value === 'auto' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
    ? value
    : null;
}

export function resolvedReasoningEffort(
  profile: PodExecutionSettings,
  snapshot?: Record<string, unknown> | null,
): ReasoningEffort {
  return reasoningEffortFromSnapshot(snapshot) ?? profile.reasoningEffort ?? 'auto';
}
