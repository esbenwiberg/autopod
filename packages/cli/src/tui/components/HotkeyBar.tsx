import React from 'react';
import { Box, Text } from 'ink';
import type { SessionStatus } from '@autopod/shared';

interface HotkeyBarProps {
  sessionStatus: SessionStatus | null;
  hasPreviewUrl: boolean;
  hasValidated: boolean;
  hasFailed: boolean;
  hasFilter: boolean;
}

interface Hotkey {
  key: string;
  label: string;
}

function getSessionHotkeys(status: SessionStatus | null, hasPreviewUrl: boolean): Hotkey[] {
  const base: Hotkey[] = [
    { key: '↑↓', label: 'navigate' },
  ];

  if (!status) return base;

  const contextual: Hotkey[] = [];

  switch (status) {
    case 'running':
    case 'awaiting_input':
      contextual.push({ key: 't', label: 'tell' });
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'validated':
      contextual.push({ key: 'a', label: 'approve' });
      contextual.push({ key: 'r', label: 'reject' });
      contextual.push({ key: 'd', label: 'diff' });
      if (hasPreviewUrl) contextual.push({ key: 'o', label: 'open' });
      break;
    case 'validating':
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'failed':
      contextual.push({ key: 'd', label: 'diff' });
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'v', label: 'validate' });
      contextual.push({ key: 'R', label: 'retry' });
      break;
    case 'killed':
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'R', label: 'retry' });
      break;
    default:
      contextual.push({ key: 'l', label: 'logs' });
      break;
  }

  return [...base, ...contextual];
}

function getGlobalHotkeys(hasValidated: boolean, hasFailed: boolean, hasFilter: boolean): Hotkey[] {
  const hotkeys: Hotkey[] = [
    { key: 'n', label: 'new' },
  ];

  if (hasValidated) hotkeys.push({ key: 'A', label: 'approve-all' });
  if (hasFailed) hotkeys.push({ key: 'X', label: 'kill-failed' });

  hotkeys.push({ key: '/', label: 'filter' });
  if (hasFilter) hotkeys.push({ key: 'Esc', label: 'clear filter' });
  hotkeys.push({ key: 'q', label: 'quit' });

  return hotkeys;
}

function HotkeyRow({ hotkeys }: { hotkeys: Hotkey[] }): React.ReactElement {
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

export function HotkeyBar({ sessionStatus, hasPreviewUrl, hasValidated, hasFailed, hasFilter }: HotkeyBarProps): React.ReactElement {
  const sessionHotkeys = getSessionHotkeys(sessionStatus, hasPreviewUrl);
  const globalHotkeys = getGlobalHotkeys(hasValidated, hasFailed, hasFilter);

  return (
    <Box flexDirection="column">
      <HotkeyRow hotkeys={sessionHotkeys} />
      <HotkeyRow hotkeys={globalHotkeys} />
    </Box>
  );
}
