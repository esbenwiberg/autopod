import React from 'react';
import { Box, Text } from 'ink';
import type { SessionStatus } from '@autopod/shared';

interface HotkeyBarProps {
  sessionStatus: SessionStatus | null;
}

interface Hotkey {
  key: string;
  label: string;
}

function getHotkeys(status: SessionStatus | null): Hotkey[] {
  const base: Hotkey[] = [
    { key: '\u2191\u2193', label: 'navigate' },
  ];

  if (!status) {
    return [...base, { key: 'q', label: 'quit' }];
  }

  const contextual: Hotkey[] = [];

  switch (status) {
    case 'running':
      contextual.push({ key: 't', label: 'tell' });
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'awaiting_input':
      contextual.push({ key: 't', label: 'tell' });
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'validated':
      contextual.push({ key: 'a', label: 'approve' });
      contextual.push({ key: 'r', label: 'reject' });
      contextual.push({ key: 'd', label: 'diff' });
      contextual.push({ key: 'o', label: 'open' });
      break;
    case 'validating':
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'failed':
      contextual.push({ key: 'd', label: 'diff' });
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'v', label: 'validate' });
      break;
    default:
      contextual.push({ key: 'l', label: 'logs' });
      break;
  }

  return [...base, ...contextual, { key: 'q', label: 'quit' }];
}

export function HotkeyBar({ sessionStatus }: HotkeyBarProps): React.ReactElement {
  const hotkeys = getHotkeys(sessionStatus);

  return (
    <Box paddingX={1} gap={1}>
      {hotkeys.map((hk) => (
        <Box key={hk.key}>
          <Text bold color="cyan">[{hk.key}]</Text>
          <Text> {hk.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
