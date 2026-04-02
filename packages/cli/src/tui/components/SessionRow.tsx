import type { OutputMode, Session } from '@autopod/shared';
import { Box, Text } from 'ink';
import type React from 'react';
import type { ColumnWidths } from '../utils/layout.js';
import { truncate } from '../utils/truncate.js';
import { HeartbeatDot } from './HeartbeatDot.js';
import { StatusBadge } from './StatusBadge.js';

interface SessionRowProps {
  session: Session;
  selected: boolean;
  columns: ColumnWidths;
}

const MODE_LABEL: Record<OutputMode, string> = {
  pr: 'PR ',
  artifact: 'ART',
  workspace: 'WS ',
};

const MODE_COLOR: Record<OutputMode, string> = {
  pr: 'cyan',
  artifact: 'magenta',
  workspace: 'yellow',
};

export function SessionRow({ session, selected, columns }: SessionRowProps): React.ReactElement {
  const prefix = selected ? '\u25B8 ' : '  ';
  const modeLabel = MODE_LABEL[session.outputMode] ?? 'PR ';
  const modeColor = MODE_COLOR[session.outputMode] ?? 'cyan';
  // Show a small link indicator when this session is part of a linked pair
  const idText = session.linkedSessionId
    ? `${truncate(session.id, columns.id - 1).padEnd(columns.id - 1)}\u21C6`
    : truncate(session.id, columns.id).padEnd(columns.id);

  return (
    <Box>
      <Text bold={selected}>
        {prefix}
        <Text>{idText}</Text>
        {'  '}
        <Text>{truncate(session.profileName, columns.profile).padEnd(columns.profile)}</Text>
        {'  '}
        <Text>{truncate(session.task, columns.task).padEnd(columns.task)}</Text>
        {'  '}
        <Text>{truncate(session.model, columns.model).padEnd(columns.model)}</Text>
        {'  '}
      </Text>
      <Text color={modeColor} dimColor={!selected}>
        {modeLabel}
      </Text>
      <Text>{'  '}</Text>
      <HeartbeatDot status={session.status} lastHeartbeatAt={session.lastHeartbeatAt} />
      <StatusBadge status={session.status} />
    </Box>
  );
}
