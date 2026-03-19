import type { AgentEvent } from '@autopod/shared';
import { Box, Text } from 'ink';
import type React from 'react';

interface MetricsBarProps {
  events: AgentEvent[];
  startedAt: string | null;
  completedAt: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export function MetricsBar({
  events,
  startedAt,
  filesChanged,
  linesAdded,
  linesRemoved,
}: MetricsBarProps): React.ReactElement {
  const toolCount = events.filter((e) => e.type === 'tool_use').length;
  const fileEvents = events.filter((e) => e.type === 'file_change').length;

  const duration = startedAt ? formatElapsed(Date.now() - new Date(startedAt).getTime()) : '-';

  return (
    <Box gap={2}>
      <Box>
        <Text dimColor>Tools: </Text>
        <Text>{toolCount}</Text>
      </Box>
      <Box>
        <Text dimColor>Edits: </Text>
        <Text>{fileEvents}</Text>
      </Box>
      <Box>
        <Text dimColor>Files: </Text>
        <Text>{filesChanged}</Text>
      </Box>
      <Box>
        <Text dimColor>Lines: </Text>
        <Text color="green">+{linesAdded}</Text>
        <Text> </Text>
        <Text color="red">-{linesRemoved}</Text>
      </Box>
      <Box>
        <Text dimColor>Time: </Text>
        <Text>{duration}</Text>
      </Box>
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
