import chalk from 'chalk';
import type { SessionStatus } from '@autopod/shared';

interface StatusStyle {
  color: (text: string) => string;
  symbol: string;
  label: string;
}

const STATUS_MAP: Record<SessionStatus, StatusStyle> = {
  queued: { color: chalk.dim, symbol: '○', label: 'Queued' },
  provisioning: { color: chalk.dim, symbol: '◌', label: 'Provisioning' },
  running: { color: chalk.cyan, symbol: '◉', label: 'Running' },
  awaiting_input: { color: chalk.yellow.bold, symbol: '?', label: 'Awaiting Input' },
  validating: { color: chalk.blue, symbol: '⟳', label: 'Validating' },
  validated: { color: chalk.green, symbol: '●', label: 'Validated' },
  failed: { color: chalk.red, symbol: '✗', label: 'Failed' },
  approved: { color: chalk.green.bold, symbol: '✓', label: 'Approved' },
  merging: { color: chalk.green, symbol: '⟳', label: 'Merging' },
  complete: { color: chalk.dim.green, symbol: '✓', label: 'Complete' },
  paused: { color: chalk.yellow.bold, symbol: '⏸', label: 'Paused' },
  killing: { color: chalk.dim.red, symbol: '⟳', label: 'Killing' },
  killed: { color: chalk.dim.red, symbol: '✗', label: 'Killed' },
};

export function getStatusStyle(status: SessionStatus): StatusStyle {
  return STATUS_MAP[status] ?? { color: chalk.white, symbol: '?', label: status };
}

export function formatStatus(status: SessionStatus): string {
  const style = getStatusStyle(status);
  return style.color(`${style.symbol} ${style.label}`);
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatDurationFromDates(start: string | null, end: string | null): string {
  if (!start) return '-';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  return formatDuration(endMs - startMs);
}

export { chalk };
