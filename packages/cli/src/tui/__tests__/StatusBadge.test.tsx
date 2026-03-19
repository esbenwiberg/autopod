import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBadge } from '../components/StatusBadge.js';
import type { SessionStatus } from '@autopod/shared';

const ALL_STATUSES: SessionStatus[] = [
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'validating',
  'validated',
  'failed',
  'approved',
  'merging',
  'complete',
  'killing',
  'killed',
];

describe('StatusBadge', () => {
  it.each(ALL_STATUSES)('renders %s status without crashing', (status) => {
    const { lastFrame } = render(<StatusBadge status={status} />);
    const output = lastFrame();
    expect(output).toBeTruthy();
    // Output should contain the status name
    expect(output).toContain(status);
  });

  it('shows correct symbol for running status', () => {
    const { lastFrame } = render(<StatusBadge status="running" />);
    expect(lastFrame()).toContain('\u25C9');
  });

  it('shows correct symbol for failed status', () => {
    const { lastFrame } = render(<StatusBadge status="failed" />);
    expect(lastFrame()).toContain('\u2717');
  });

  it('shows correct symbol for approved status', () => {
    const { lastFrame } = render(<StatusBadge status="approved" />);
    expect(lastFrame()).toContain('\u2713');
  });
});
