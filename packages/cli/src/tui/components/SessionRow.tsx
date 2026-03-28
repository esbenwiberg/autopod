import type { Session } from '@autopod/shared';
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

export function SessionRow({ session, selected, columns }: SessionRowProps): React.ReactElement {
  const prefix = selected ? '\u25B8 ' : '  ';

  return (
    <Box>
      <Text bold={selected}>
        {prefix}
        <Text>{truncate(session.id, columns.id).padEnd(columns.id)}</Text>
        {'  '}
        <Text>{truncate(session.profileName, columns.profile).padEnd(columns.profile)}</Text>
        {'  '}
        <Text>{truncate(session.task, columns.task).padEnd(columns.task)}</Text>
        {'  '}
        <Text>{truncate(session.model, columns.model).padEnd(columns.model)}</Text>
        {'  '}
      </Text>
      <HeartbeatDot status={session.status} lastHeartbeatAt={session.lastHeartbeatAt} />
      <StatusBadge status={session.status} />
    </Box>
  );
}
