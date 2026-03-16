import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SessionTable } from '../components/SessionTable.js';
import { calculateColumns } from '../utils/layout.js';
import type { Session } from '@autopod/shared';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'abc12',
    profileName: 'web-app',
    task: 'Fix the login page',
    status: 'running',
    model: 'sonnet',
    runtime: 'claude',
    branch: 'fix/login',
    containerId: null,
    worktreePath: null,
    validationAttempts: 0,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: '2026-03-16T10:00:00Z',
    startedAt: '2026-03-16T10:01:00Z',
    completedAt: null,
    updatedAt: '2026-03-16T10:02:00Z',
    userId: 'user1',
    filesChanged: 3,
    linesAdded: 45,
    linesRemoved: 12,
    previewUrl: null,
    ...overrides,
  };
}

describe('SessionTable', () => {
  const columns = calculateColumns(120);

  it('renders empty state when no sessions', () => {
    const { lastFrame } = render(
      <SessionTable sessions={[]} selectedIndex={0} columns={columns} maxRows={10} />,
    );
    expect(lastFrame()).toContain('No sessions');
  });

  it('renders session data', () => {
    const sessions = [makeSession()];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} selectedIndex={0} columns={columns} maxRows={10} />,
    );
    const output = lastFrame()!;
    expect(output).toContain('abc12');
    expect(output).toContain('web-app');
    expect(output).toContain('Fix the login page');
    expect(output).toContain('sonnet');
    expect(output).toContain('running');
  });

  it('renders column headers', () => {
    const sessions = [makeSession()];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} selectedIndex={0} columns={columns} maxRows={10} />,
    );
    const output = lastFrame()!;
    expect(output).toContain('ID');
    expect(output).toContain('PROFILE');
    expect(output).toContain('TASK');
    expect(output).toContain('MODEL');
    expect(output).toContain('STATUS');
  });

  it('shows selection indicator on selected row', () => {
    const sessions = [makeSession(), makeSession({ id: 'def34', task: 'Other task' })];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} selectedIndex={0} columns={columns} maxRows={10} />,
    );
    const output = lastFrame()!;
    // Selected row should have the ▸ prefix
    expect(output).toContain('\u25B8');
  });

  it('renders multiple sessions', () => {
    const sessions = [
      makeSession({ id: 'ses01', task: 'First task' }),
      makeSession({ id: 'ses02', task: 'Second task', status: 'validated' }),
      makeSession({ id: 'ses03', task: 'Third task', status: 'failed' }),
    ];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} selectedIndex={1} columns={columns} maxRows={10} />,
    );
    const output = lastFrame()!;
    expect(output).toContain('ses01');
    expect(output).toContain('ses02');
    expect(output).toContain('ses03');
  });
});
