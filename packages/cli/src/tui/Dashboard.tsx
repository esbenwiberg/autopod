import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { exec } from 'child_process';
import type { AgentEvent, Session } from '@autopod/shared';
import type { UseSessionStateReturn } from './hooks/useSessionState.js';
import type { UseWebSocketReturn } from './hooks/useWebSocket.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useSelection } from './hooks/useSelection.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { calculateColumns } from './utils/layout.js';
import { Header } from './components/Header.js';
import { SessionTable } from './components/SessionTable.js';
import { DetailPanel } from './components/DetailPanel.js';
import { HotkeyBar } from './components/HotkeyBar.js';
import { InlineInput } from './components/InlineInput.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { DiffView } from './components/DiffView.js';
import { CreateSessionWizard } from './components/CreateSessionWizard.js';
import { Toast } from './components/Toast.js';
import { useClient } from './App.js';

type UIMode =
  | { type: 'normal' }
  | { type: 'tell_input' }
  | { type: 'reject_input' }
  | { type: 'confirm_approve' }
  | { type: 'confirm_kill' }
  | { type: 'diff_view'; diff: string }
  | { type: 'log_view' }
  | { type: 'create_session' }
  | { type: 'confirm_retry'; session: Session }
  | { type: 'confirm_bulk_approve'; count: number }
  | { type: 'confirm_bulk_kill'; count: number }
  | { type: 'filter_input' };

interface DashboardProps {
  sessionState: UseSessionStateReturn;
  ws: UseWebSocketReturn;
  agentEvents: Map<string, AgentEvent[]>;
}

function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`);
}

export function Dashboard({ sessionState, ws, agentEvents }: DashboardProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();
  const client = useClient();

  const { sessions, selectedSession, loading, error, refresh } = sessionState;

  // Filter state
  const [filterText, setFilterText] = useState('');
  const filteredSessions = useMemo(() => {
    if (!filterText) return sessions;
    const lower = filterText.toLowerCase();
    return sessions.filter(s =>
      s.task.toLowerCase().includes(lower) ||
      s.profileName.toLowerCase().includes(lower) ||
      s.id.toLowerCase().includes(lower) ||
      s.status.includes(lower),
    );
  }, [sessions, filterText]);

  // Toast state
  const [toast, setToast] = useState<{ message: string; color: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, color = 'green') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, color });
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // Cleanup toast timer on unmount
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const selection = useSelection(filteredSessions.length);
  const [mode, setMode] = useState<UIMode>({ type: 'normal' });

  // Sync selection to session state
  const currentSession = filteredSessions[selection.selectedIndex] ?? null;
  const currentSessionId = currentSession?.id ?? null;

  // Update selected session ID when selection changes
  React.useEffect(() => {
    sessionState.setSelectedSessionId(currentSessionId);
  }, [currentSessionId, sessionState]);

  const columnWidths = useMemo(() => calculateColumns(columns), [columns]);

  const isOverlayActive = mode.type !== 'normal';

  // Action handlers — using AutopodClient instead of bare fetch
  const handleTell = useCallback(async (message: string) => {
    if (!currentSessionId) return;
    try {
      await client.sendMessage(currentSessionId, message);
    } catch {
      showToast('Failed to send message', 'red');
    }
    setMode({ type: 'normal' });
  }, [currentSessionId, client, showToast]);

  const handleApprove = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await client.approveSession(currentSessionId);
    } catch {
      showToast('Failed to approve session', 'red');
    }
    setMode({ type: 'normal' });
  }, [currentSessionId, client, showToast]);

  const handleKill = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await client.killSession(currentSessionId);
    } catch {
      showToast('Failed to kill session', 'red');
    }
    setMode({ type: 'normal' });
  }, [currentSessionId, client, showToast]);

  const handleReject = useCallback(async (reason: string) => {
    if (!currentSessionId) return;
    try {
      await client.rejectSession(currentSessionId, reason);
    } catch {
      showToast('Failed to reject session', 'red');
    }
    setMode({ type: 'normal' });
  }, [currentSessionId, client, showToast]);

  const handleCreateComplete = useCallback((session: Session) => {
    setMode({ type: 'normal' });
    showToast(`Session created: ${session.id.slice(0, 8)}`, 'green');
    void refresh();
  }, [showToast, refresh]);

  const handleRetry = useCallback(async () => {
    if (mode.type !== 'confirm_retry') return;
    const { session } = mode;
    try {
      const newSession = await client.createSession({
        profileName: session.profileName,
        task: session.task,
      });
      showToast(`Retry started: ${newSession.id.slice(0, 8)}`, 'green');
      void refresh();
    } catch {
      showToast('Failed to retry session', 'red');
    }
    setMode({ type: 'normal' });
  }, [mode, client, showToast, refresh]);

  const handleBulkApprove = useCallback(async () => {
    try {
      const result = await client.approveAllValidated();
      showToast(`Approved ${result.approved.length} sessions`, 'green');
      void refresh();
    } catch {
      showToast('Failed to bulk approve', 'red');
    }
    setMode({ type: 'normal' });
  }, [client, showToast, refresh]);

  const handleBulkKill = useCallback(async () => {
    try {
      const result = await client.killAllFailed();
      showToast(`Killed ${result.killed.length} sessions`, 'green');
      void refresh();
    } catch {
      showToast('Failed to bulk kill', 'red');
    }
    setMode({ type: 'normal' });
  }, [client, showToast, refresh]);

  // Keyboard handlers
  const keyHandlers = useMemo(
    () => ({
      up: () => selection.moveUp(),
      down: () => selection.moveDown(),
      t: () => {
        if (currentSession?.status === 'running' || currentSession?.status === 'awaiting_input') {
          setMode({ type: 'tell_input' });
        }
      },
      d: () => {
        const diffText = selectedSession?.lastValidationResult?.taskReview?.diff;
        if (diffText) {
          setMode({ type: 'diff_view', diff: diffText });
        }
      },
      a: () => {
        if (currentSession?.status === 'validated') {
          setMode({ type: 'confirm_approve' });
        }
      },
      r: () => {
        if (currentSession?.status === 'validated') {
          setMode({ type: 'reject_input' });
        }
      },
      l: () => {
        setMode({ type: 'log_view' });
      },
      x: () => {
        if (currentSession) {
          setMode({ type: 'confirm_kill' });
        }
      },
      v: () => {
        if (currentSession?.status === 'failed' && currentSessionId) {
          void client.triggerValidation(currentSessionId).catch(() => {
            showToast('Failed to trigger validation', 'red');
          });
        }
      },
      n: () => {
        setMode({ type: 'create_session' });
      },
      R: () => {
        if (currentSession && ['killed', 'failed'].includes(currentSession.status)) {
          setMode({ type: 'confirm_retry', session: currentSession });
        }
      },
      o: () => {
        if (currentSession?.previewUrl) {
          openUrl(currentSession.previewUrl);
        }
      },
      A: () => {
        const count = sessions.filter(s => s.status === 'validated').length;
        if (count > 0) setMode({ type: 'confirm_bulk_approve', count });
      },
      X: () => {
        const count = sessions.filter(s => s.status === 'failed').length;
        if (count > 0) setMode({ type: 'confirm_bulk_kill', count });
      },
      '/': () => {
        setMode({ type: 'filter_input' });
      },
      escape: () => {
        if (filterText) {
          setFilterText('');
        }
      },
      q: () => {
        ws.disconnect();
        exit();
      },
    }),
    [selection, currentSession, currentSessionId, selectedSession, sessions, ws, exit, client, showToast, filterText],
  );

  useKeyboard(keyHandlers, !isOverlayActive);

  // Terminal too small check
  if (columns < 80 || rows < 24) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red" bold>Terminal too small</Text>
        <Text>
          Minimum 80x24 required (current: {columns}x{rows})
        </Text>
        <Text dimColor>Resize your terminal and try again.</Text>
      </Box>
    );
  }

  // Loading state
  if (loading && sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Header connected={ws.connected} reconnecting={ws.reconnecting} sessionCount={0} />
        <Box paddingX={1}>
          <Text dimColor>Loading sessions...</Text>
        </Box>
      </Box>
    );
  }

  // Error state
  if (error && sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Header connected={ws.connected} reconnecting={ws.reconnecting} sessionCount={0} />
        <Box paddingX={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>Press q to quit, or wait for reconnection.</Text>
        </Box>
      </Box>
    );
  }

  // How many rows for the session table (leave room for header, detail, hotkey bar)
  const tableMaxRows = Math.max(3, Math.floor((rows - 6) / 2));
  const activityMaxLines = Math.max(3, Math.floor((rows - 6) / 3));

  const sessionEvents = currentSessionId ? agentEvents.get(currentSessionId) ?? [] : [];

  // HotkeyBar props
  const hasPreviewUrl = !!currentSession?.previewUrl;
  const hasValidated = sessions.some(s => s.status === 'validated');
  const hasFailed = sessions.some(s => s.status === 'failed');
  const hasFilter = filterText.length > 0;

  return (
    <Box flexDirection="column" height={rows}>
      <Header
        connected={ws.connected}
        reconnecting={ws.reconnecting}
        sessionCount={filteredSessions.length}
      />

      {hasFilter && (
        <Box paddingX={1}>
          <Text dimColor>Filter: </Text>
          <Text color="yellow">{filterText}</Text>
          <Text dimColor> ({filteredSessions.length}/{sessions.length} sessions)</Text>
        </Box>
      )}

      <SessionTable
        sessions={filteredSessions}
        selectedIndex={selection.selectedIndex}
        columns={columnWidths}
        maxRows={tableMaxRows}
      />

      <DetailPanel
        session={selectedSession}
        events={sessionEvents}
        maxActivityLines={activityMaxLines}
      />

      {/* Overlays */}
      {mode.type === 'tell_input' && (
        <InlineInput
          prompt="Send message to agent:"
          onSubmit={(msg) => void handleTell(msg)}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'reject_input' && (
        <InlineInput
          prompt="Rejection reason:"
          onSubmit={(reason) => void handleReject(reason)}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'confirm_approve' && (
        <ConfirmDialog
          message="Approve this session and merge?"
          onConfirm={() => void handleApprove()}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'confirm_kill' && (
        <ConfirmDialog
          message={`Kill session ${currentSessionId ?? ''}?`}
          onConfirm={() => void handleKill()}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'diff_view' && (
        <DiffView
          diff={mode.diff}
          onClose={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'log_view' && (
        <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
          <Box justifyContent="space-between">
            <Text bold>Activity Log — {currentSessionId}</Text>
            <Text dimColor>Esc to close</Text>
          </Box>
          <ActivityLogOverlay
            events={sessionEvents}
            onClose={() => setMode({ type: 'normal' })}
          />
        </Box>
      )}

      {mode.type === 'create_session' && (
        <CreateSessionWizard
          client={client}
          onComplete={handleCreateComplete}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'confirm_retry' && (
        <ConfirmDialog
          message={`Retry "${mode.session.task.slice(0, 50)}" with profile ${mode.session.profileName}?`}
          onConfirm={() => void handleRetry()}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'confirm_bulk_approve' && (
        <ConfirmDialog
          message={`Approve all ${mode.count} validated sessions?`}
          onConfirm={() => void handleBulkApprove()}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'confirm_bulk_kill' && (
        <ConfirmDialog
          message={`Kill all ${mode.count} failed sessions?`}
          onConfirm={() => void handleBulkKill()}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'filter_input' && (
        <InlineInput
          prompt="Filter sessions:"
          onSubmit={(text) => {
            setFilterText(text);
            setMode({ type: 'normal' });
          }}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {toast && <Toast message={toast.message} color={toast.color} />}

      <HotkeyBar
        sessionStatus={currentSession?.status ?? null}
        hasPreviewUrl={hasPreviewUrl}
        hasValidated={hasValidated}
        hasFailed={hasFailed}
        hasFilter={hasFilter}
      />
    </Box>
  );
}

// Simple log overlay component
function ActivityLogOverlay({
  events,
  onClose,
}: {
  events: AgentEvent[];
  onClose: () => void;
}): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) onClose();
  });

  if (events.length === 0) {
    return <Text dimColor>No events recorded</Text>;
  }

  return (
    <Box flexDirection="column">
      {events.slice(-20).map((event, i) => (
        <Text key={`log-${i}`} dimColor>
          [{event.timestamp}] {event.type}: {'message' in event ? (event as { message: string }).message : event.type}
        </Text>
      ))}
    </Box>
  );
}
