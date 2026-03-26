import type { SessionStatus } from '@autopod/shared';
import { Box, Text } from 'ink';
import type React from 'react';

interface HotkeyBarProps {
  sessionStatus: SessionStatus | null;
  hasPreviewUrl: boolean;
  hasValidated: boolean;
  hasFailed: boolean;
  hasFilter: boolean;
  hasValidationResult: boolean;
  hasContainerId: boolean;
  hasPrUrl: boolean;
}

interface Hotkey {
  key: string;
  label: string;
}

interface SessionHotkeyContext {
  hasPreviewUrl: boolean;
  hasValidationResult: boolean;
  hasContainerId: boolean;
  hasPrUrl: boolean;
}

function getOpenLabel(ctx: SessionHotkeyContext): string {
  if (ctx.hasPreviewUrl) return 'open';
  if (ctx.hasContainerId) return 'preview';
  if (ctx.hasPrUrl) return 'open PR';
  return 'open';
}

function getSessionHotkeys(status: SessionStatus | null, ctx: SessionHotkeyContext): Hotkey[] {
  const base: Hotkey[] = [{ key: '↑↓', label: 'navigate' }];

  if (!status) return base;

  const contextual: Hotkey[] = [];
  const canOpen = ctx.hasPreviewUrl || ctx.hasContainerId || ctx.hasPrUrl;

  switch (status) {
    case 'running':
      contextual.push({ key: 'p', label: 'pause' });
      contextual.push({ key: 'u', label: 'nudge' });
      contextual.push({ key: 't', label: 'tell' });
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'paused':
      contextual.push({ key: 't', label: 'tell/resume' });
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
      if (canOpen) contextual.push({ key: 'o', label: getOpenLabel(ctx) });
      if (ctx.hasValidationResult) contextual.push({ key: 'w', label: 'report' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'validating':
      contextual.push({ key: 'l', label: 'logs' });
      contextual.push({ key: 'x', label: 'kill' });
      break;
    case 'failed':
      contextual.push({ key: 'd', label: 'diff' });
      contextual.push({ key: 'l', label: 'logs' });
      if (canOpen) contextual.push({ key: 'o', label: getOpenLabel(ctx) });
      if (ctx.hasValidationResult) contextual.push({ key: 'w', label: 'report' });
      contextual.push({ key: 'v', label: 'validate' });
      contextual.push({ key: 'R', label: 'retry' });
      contextual.push({ key: 'D', label: 'delete' });
      break;
    case 'killed':
      contextual.push({ key: 'l', label: 'logs' });
      if (ctx.hasValidationResult) contextual.push({ key: 'w', label: 'report' });
      contextual.push({ key: 'R', label: 'retry' });
      contextual.push({ key: 'D', label: 'delete' });
      break;
    case 'complete':
      contextual.push({ key: 'l', label: 'logs' });
      if (ctx.hasValidationResult) contextual.push({ key: 'w', label: 'report' });
      contextual.push({ key: 'D', label: 'delete' });
      break;
    case 'killing':
      contextual.push({ key: 'D', label: 'delete' });
      break;
    default:
      contextual.push({ key: 'l', label: 'logs' });
      break;
  }

  return [...base, ...contextual];
}

function getGlobalHotkeys(hasValidated: boolean, hasFailed: boolean, hasFilter: boolean): Hotkey[] {
  const hotkeys: Hotkey[] = [{ key: 'n', label: 'new' }];

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
          <Text bold color="cyan">
            [{hk.key}]
          </Text>
          <Text> {hk.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function HotkeyBar({
  sessionStatus,
  hasPreviewUrl,
  hasValidated,
  hasFailed,
  hasFilter,
  hasValidationResult,
  hasContainerId,
  hasPrUrl,
}: HotkeyBarProps): React.ReactElement {
  const sessionHotkeys = getSessionHotkeys(sessionStatus, {
    hasPreviewUrl,
    hasValidationResult,
    hasContainerId,
    hasPrUrl,
  });
  const globalHotkeys = getGlobalHotkeys(hasValidated, hasFailed, hasFilter);

  return (
    <Box flexDirection="column">
      <HotkeyRow hotkeys={sessionHotkeys} />
      <HotkeyRow hotkeys={globalHotkeys} />
    </Box>
  );
}
