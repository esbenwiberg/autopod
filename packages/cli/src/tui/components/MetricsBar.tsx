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
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function MetricsBar({
  events,
  startedAt,
  filesChanged,
  linesAdded,
  linesRemoved,
  costUsd,
  inputTokens = 0,
  outputTokens = 0,
}: MetricsBarProps): React.ReactElement {
  const toolCount = events.filter((e) => e.type === 'tool_use').length;
  const fileEvents = events.filter((e) => e.type === 'file_change').length;
  const uniqueFiles = new Set(
    events
      .filter((e): e is import('@autopod/shared').AgentFileChangeEvent => e.type === 'file_change')
      .map((e) => e.path),
  ).size;

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
        <Text>{filesChanged > 0 ? filesChanged : uniqueFiles > 0 ? uniqueFiles : 0}</Text>
      </Box>
      <Box>
        <Text dimColor>Lines: </Text>
        {filesChanged > 0 ? (
          <>
            <Text color="green">+{linesAdded}</Text>
            <Text> </Text>
            <Text color="red">-{linesRemoved}</Text>
          </>
        ) : uniqueFiles > 0 ? (
          <Text dimColor>-</Text>
        ) : (
          <>
            <Text color="green">+{linesAdded}</Text>
            <Text> </Text>
            <Text color="red">-{linesRemoved}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text dimColor>Time: </Text>
        <Text>{duration}</Text>
      </Box>
      <Box>
        <Text dimColor>Tok: </Text>
        <Text dimColor={inputTokens === 0}>{formatTokens(inputTokens)}</Text>
        <Text dimColor>&#8593;</Text>
        <Text dimColor={outputTokens === 0}>{formatTokens(outputTokens)}</Text>
        <Text dimColor>&#8595;</Text>
      </Box>
      <Box>
        <Text dimColor>Cost: </Text>
        <Text dimColor={costUsd == null || costUsd === 0}>${(costUsd ?? 0).toFixed(3)}</Text>
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
