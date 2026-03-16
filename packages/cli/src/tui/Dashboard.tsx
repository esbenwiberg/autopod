import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { AgentEvent } from '@autopod/shared';
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

type UIMode =
  | { type: 'normal' }
  | { type: 'tell_input' }
  | { type: 'reject_input' }
  | { type: 'confirm_approve' }
  | { type: 'confirm_kill' }
  | { type: 'diff_view'; diff: string }
  | { type: 'log_view' };

interface DashboardProps {
  sessionState: UseSessionStateReturn;
  ws: UseWebSocketReturn;
  agentEvents: Map<string, AgentEvent[]>;
}

export function Dashboard({ sessionState, ws, agentEvents }: DashboardProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();

  const { sessions, selectedSession, loading, error, refresh } = sessionState;

  const selection = useSelection(sessions.length);
  const [mode, setMode] = useState<UIMode>({ type: 'normal' });

  // Sync selection to session state
  const currentSession = sessions[selection.selectedIndex] ?? null;
  const currentSessionId = currentSession?.id ?? null;

  // Update selected session ID when selection changes
  React.useEffect(() => {
    sessionState.setSelectedSessionId(currentSessionId);
  }, [currentSessionId, sessionState]);

  const columnWidths = useMemo(() => calculateColumns(columns), [columns]);

  const isOverlayActive = mode.type !== 'normal';

  // Action handlers
  const handleTell = useCallback(async (message: string) => {
    if (!currentSessionId) return;
    try {
      await fetch(`/sessions/${currentSessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    } catch {
      // Silent fail — daemon may handle via WS
    }
    setMode({ type: 'normal' });
  }, [currentSessionId]);

  const handleApprove = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await fetch(`/sessions/${currentSessionId}/approve`, { method: 'POST' });
    } catch {
      // Silent fail
    }
    setMode({ type: 'normal' });
  }, [currentSessionId]);

  const handleKill = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await fetch(`/sessions/${currentSessionId}/kill`, { method: 'POST' });
    } catch {
      // Silent fail
    }
    setMode({ type: 'normal' });
  }, [currentSessionId]);

  const handleReject = useCallback(async (reason: string) => {
    if (!currentSessionId) return;
    try {
      await fetch(`/sessions/${currentSessionId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
    } catch {
      // Silent fail
    }
    setMode({ type: 'normal' });
  }, [currentSessionId]);

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
        // Show diff if available from last validation
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
        if (currentSession?.status === 'failed') {
          // Re-trigger validation via REST
          void fetch(`/sessions/${currentSessionId}/validate`, { method: 'POST' }).catch(() => {});
        }
      },
      q: () => {
        ws.disconnect();
        exit();
      },
    }),
    [selection, currentSession, currentSessionId, selectedSession, ws, exit],
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

  return (
    <Box flexDirection="column" height={rows}>
      <Header
        connected={ws.connected}
        reconnecting={ws.reconnecting}
        sessionCount={sessions.length}
      />

      <SessionTable
        sessions={sessions}
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

      <HotkeyBar sessionStatus={currentSession?.status ?? null} />
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
