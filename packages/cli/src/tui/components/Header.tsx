import { Box, Text } from 'ink';
import type React from 'react';

interface HeaderProps {
  connected: boolean;
  reconnecting: boolean;
  sessionCount: number;
}

export function Header({ connected, reconnecting, sessionCount }: HeaderProps): React.ReactElement {
  let connectionColor: string;
  let connectionLabel: string;

  if (connected) {
    connectionColor = 'green';
    connectionLabel = '\u25CF connected';
  } else if (reconnecting) {
    connectionColor = 'yellow';
    connectionLabel = '\u25CF reconnecting\u2026';
  } else {
    connectionColor = 'red';
    connectionLabel = '\u25CF disconnected';
  }

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>autopod</Text>
      <Text color={connectionColor}>{connectionLabel}</Text>
      <Text>
        {sessionCount} session{sessionCount !== 1 ? 's' : ''}
      </Text>
    </Box>
  );
}
