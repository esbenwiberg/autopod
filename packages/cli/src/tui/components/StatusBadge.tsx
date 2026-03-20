import type { SessionStatus } from '@autopod/shared';
import { Text } from 'ink';
import type React from 'react';

interface StatusBadgeProps {
  status: SessionStatus;
}

interface StatusStyle {
  symbol: string;
  color: string | undefined;
  bold: boolean;
  dimColor: boolean;
}

const STATUS_MAP: Record<SessionStatus, StatusStyle> = {
  queued: { symbol: '\u25CB', color: undefined, bold: false, dimColor: true },
  provisioning: { symbol: '\u25CC', color: undefined, bold: false, dimColor: true },
  running: { symbol: '\u25C9', color: 'cyan', bold: false, dimColor: false },
  awaiting_input: { symbol: '?', color: 'yellow', bold: true, dimColor: false },
  validating: { symbol: '\u27F3', color: 'blue', bold: false, dimColor: false },
  validated: { symbol: '\u25CF', color: 'green', bold: false, dimColor: false },
  failed: { symbol: '\u2717', color: 'red', bold: false, dimColor: false },
  approved: { symbol: '\u2713', color: 'green', bold: true, dimColor: false },
  merging: { symbol: '\u27F3', color: 'green', bold: false, dimColor: false },
  complete: { symbol: '\u2713', color: 'green', bold: false, dimColor: true },
  paused: { symbol: '\u23F8', color: 'yellow', bold: true, dimColor: false },
  killing: { symbol: '\u27F3', color: 'red', bold: false, dimColor: true },
  killed: { symbol: '\u2717', color: 'red', bold: false, dimColor: true },
};

export function StatusBadge({ status }: StatusBadgeProps): React.ReactElement {
  const style = STATUS_MAP[status];
  const label = `${style.symbol} ${status}`;

  return (
    <Text color={style.color} bold={style.bold} dimColor={style.dimColor}>
      {label}
    </Text>
  );
}
