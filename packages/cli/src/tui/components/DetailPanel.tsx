import React from 'react';
import { Box, Text } from 'ink';
import type { Session, AgentEvent } from '@autopod/shared';
import { StatusBadge } from './StatusBadge.js';
import { ActivityFeed } from './ActivityFeed.js';

interface DetailPanelProps {
  session: Session | null;
  events: AgentEvent[];
  maxActivityLines: number;
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function DetailPanel({ session, events, maxActivityLines }: DetailPanelProps): React.ReactElement {
  if (!session) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>Select a session to view details</Text>
      </Box>
    );
  }

  const validation = session.lastValidationResult;

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold>Session {session.id}</Text>
        <StatusBadge status={session.status} />
      </Box>

      {/* Details grid */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text dimColor>{'Task:     '}</Text>
          <Text>{session.task}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Model:    '}</Text>
          <Text>{session.model}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Profile:  '}</Text>
          <Text>{session.profileName}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Branch:   '}</Text>
          <Text>{session.branch || '-'}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Duration: '}</Text>
          <Text>{formatDuration(session.startedAt, session.completedAt)}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Files:    '}</Text>
          <Text>
            {session.filesChanged} changed, +{session.linesAdded} -{session.linesRemoved}
          </Text>
        </Box>
        {session.previewUrl && (
          <Box>
            <Text dimColor>{'Preview:  '}</Text>
            <Text color="blue">{session.previewUrl}</Text>
          </Box>
        )}
      </Box>

      {/* Validation summary */}
      {validation && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Validation (attempt {validation.attempt})</Text>
          <Box>
            <Text dimColor>{'Result:   '}</Text>
            <Text color={validation.overall === 'pass' ? 'green' : 'red'}>
              {validation.overall.toUpperCase()}
            </Text>
          </Box>
          <Box>
            <Text dimColor>{'Smoke:    '}</Text>
            <Text color={validation.smoke.status === 'pass' ? 'green' : 'red'}>
              {validation.smoke.status}
            </Text>
          </Box>
          {validation.taskReview && (
            <Box>
              <Text dimColor>{'Review:   '}</Text>
              <Text color={validation.taskReview.status === 'pass' ? 'green' : validation.taskReview.status === 'fail' ? 'red' : 'yellow'}>
                {validation.taskReview.status}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* Activity feed */}
      <Box marginTop={1}>
        <ActivityFeed events={events} maxLines={maxActivityLines} />
      </Box>
    </Box>
  );
}
