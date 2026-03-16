import React from 'react';
import { Box, Text } from 'ink';
import type { AgentEvent } from '@autopod/shared';

interface ActivityFeedProps {
  events: AgentEvent[];
  maxLines: number;
}

function getEventIcon(event: AgentEvent): string {
  switch (event.type) {
    case 'status':
      return '\u25CF';
    case 'tool_use': {
      const tool = event.tool.toLowerCase();
      if (tool === 'read' || tool.includes('read')) return '\u25C7';
      if (tool === 'edit' || tool.includes('edit') || tool.includes('write')) return '\u270E';
      if (tool === 'bash' || tool.includes('bash') || tool.includes('shell')) return '$';
      return '\u25C6';
    }
    case 'file_change':
      return '\u25B3';
    case 'complete':
      return '\u2713';
    case 'error':
      return '\u2717';
    case 'escalation':
      return '?';
    default:
      return '\u25CF';
  }
}

function getEventColor(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'status':
      return 'cyan';
    case 'tool_use':
      return 'blue';
    case 'file_change':
      return 'yellow';
    case 'complete':
      return 'green';
    case 'error':
      return 'red';
    case 'escalation':
      return 'yellow';
    default:
      return undefined;
  }
}

function getEventText(event: AgentEvent): string {
  switch (event.type) {
    case 'status':
      return event.message;
    case 'tool_use':
      return `${event.tool}`;
    case 'file_change':
      return `${event.action} ${event.path}`;
    case 'complete':
      return event.result;
    case 'error':
      return event.message;
    case 'escalation':
      return `${event.escalationType}: ${event.payload.question ?? event.payload.description ?? ''}`;
    default:
      return '';
  }
}

export function ActivityFeed({ events, maxLines }: ActivityFeedProps): React.ReactElement {
  // Show most recent events (reverse chronological — latest at top)
  const visibleEvents = events.slice(-maxLines).reverse();

  if (visibleEvents.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No activity yet</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold dimColor>Activity</Text>
      {visibleEvents.map((event, i) => (
        <Box key={`${event.timestamp}-${i}`}>
          <Text color={getEventColor(event)}>{getEventIcon(event)} </Text>
          <Text wrap="truncate">{getEventText(event)}</Text>
        </Box>
      ))}
    </Box>
  );
}
