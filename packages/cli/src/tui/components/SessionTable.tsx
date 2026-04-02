import type { Session } from '@autopod/shared';
import { Box, Text } from 'ink';
import type React from 'react';
import type { ColumnWidths } from '../utils/layout.js';
import { SessionRow } from './SessionRow.js';

interface SessionTableProps {
  sessions: Session[];
  selectedIndex: number;
  columns: ColumnWidths;
  maxRows: number;
}

export function SessionTable({
  sessions,
  selectedIndex,
  columns,
  maxRows,
}: SessionTableProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>
          No sessions. Run `ap run &lt;profile&gt; &quot;task&quot;` to create one.
        </Text>
      </Box>
    );
  }

  // Scroll window: keep selected row visible
  const visibleRows = Math.min(maxRows, sessions.length);
  let startIdx = 0;
  if (selectedIndex >= visibleRows) {
    startIdx = selectedIndex - visibleRows + 1;
  }
  const endIdx = startIdx + visibleRows;
  const visibleSessions = sessions.slice(startIdx, endIdx);

  const headerPrefix = '  ';

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Column headers */}
      <Box>
        <Text dimColor bold>
          {headerPrefix}
          {'ID'.padEnd(columns.id)}
          {'  '}
          {'PROFILE'.padEnd(columns.profile)}
          {'  '}
          {'TASK'.padEnd(columns.task)}
          {'  '}
          {'MODEL'.padEnd(columns.model)}
          {'  '}
          {'MOD'.padEnd(columns.mode)}
          {'  '}
          {'STATUS'.padEnd(columns.status)}
        </Text>
      </Box>

      {/* Session rows */}
      {visibleSessions.map((session, i) => (
        <SessionRow
          key={session.id}
          session={session}
          selected={startIdx + i === selectedIndex}
          columns={columns}
        />
      ))}

      {/* Scroll indicators */}
      {sessions.length > visibleRows && (
        <Box paddingX={1}>
          <Text dimColor>
            {startIdx > 0 ? '\u2191 ' : '  '}
            {endIdx < sessions.length ? '\u2193 ' : '  '}
            {sessions.length} total
          </Text>
        </Box>
      )}
    </Box>
  );
}
