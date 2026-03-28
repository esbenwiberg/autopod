import type { SessionStatus } from '@autopod/shared';
import { Text } from 'ink';
import type React from 'react';

const ACTIVE_STATUSES = new Set<SessionStatus>([
  'provisioning',
  'running',
  'validating',
  'awaiting_input',
  'paused',
  'killing',
]);

const STALE_YELLOW_MS = 2 * 60 * 1000;
const STALE_RED_MS = 10 * 60 * 1000;

interface HeartbeatDotProps {
  status: SessionStatus;
  lastHeartbeatAt: string | null;
}

export function HeartbeatDot({
  status,
  lastHeartbeatAt,
}: HeartbeatDotProps): React.ReactElement | null {
  if (!ACTIVE_STATUSES.has(status)) return null;

  let color: string;
  if (!lastHeartbeatAt) {
    // No heartbeat yet — session just started
    color = 'yellow';
  } else {
    const ageMs = Date.now() - new Date(lastHeartbeatAt).getTime();
    if (ageMs < STALE_YELLOW_MS) {
      color = 'green';
    } else if (ageMs < STALE_RED_MS) {
      color = 'yellow';
    } else {
      color = 'red';
    }
  }

  return <Text color={color}>{'\u25CF'}</Text>;
}
