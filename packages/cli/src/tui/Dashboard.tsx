import { exec } from 'node:child_process';
import type { AgentEvent, Session, ValidationResult } from '@autopod/shared';
import { Box, Text, useApp, useInput } from 'ink';
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useClient } from './App.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { CreateSessionWizard } from './components/CreateSessionWizard.js';
import { DetailPanel } from './components/DetailPanel.js';
import { DiffView } from './components/DiffView.js';
import { Header } from './components/Header.js';
import { HotkeyBar } from './components/HotkeyBar.js';
import { InlineInput } from './components/InlineInput.js';
import { SessionTable } from './components/SessionTable.js';
import { Toast } from './components/Toast.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useSelection } from './hooks/useSelection.js';
import type { UseSessionStateReturn } from './hooks/useSessionState.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import type { UseWebSocketReturn } from './hooks/useWebSocket.js';
import { formatToolUse, getToolUseKey } from './utils/formatToolUse.js';
import { calculateColumns } from './utils/layout.js';

type UIMode =
  | { type: 'normal' }
  | { type: 'tell_input' }
  | { type: 'reject_input' }
  | { type: 'confirm_approve' }
  | { type: 'confirm_kill' }
  | { type: 'confirm_delete' }
  | { type: 'diff_view'; diff: string }
  | { type: 'log_view' }
  | { type: 'create_session' }
  | { type: 'confirm_retry'; session: Session }
  | { type: 'confirm_bulk_approve'; count: number }
  | { type: 'confirm_bulk_kill'; count: number }
  | { type: 'filter_input' }
  | { type: 'nudge_input' };

interface DashboardProps {
  sessionState: UseSessionStateReturn;
  ws: UseWebSocketReturn;
  agentEvents: Map<string, AgentEvent[]>;
  daemonUrl: string;
}

function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`);
}

export function Dashboard({
  sessionState,
  ws,
  agentEvents,
  daemonUrl,
}: DashboardProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();
  const client = useClient();

  const { sessions, selectedSession, loading, error, refresh } = sessionState;

  // Filter state
  const [filterText, setFilterText] = useState('');
  const filteredSessions = useMemo(() => {
    if (!filterText) return sessions;
    const lower = filterText.toLowerCase();
    return sessions.filter(
      (s) =>
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
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const selection = useSelection(filteredSessions.length);
  const [mode, setMode] = useState<UIMode>({ type: 'normal' });

  // Sync selection to session state
  const currentSession = filteredSessions[selection.selectedIndex] ?? null;
  const currentSessionId = currentSession?.id ?? null;

  // Update selected session ID when selection changes
  React.useEffect(() => {
    sessionState.setSelectedSessionId(currentSessionId);
  }, [currentSessionId, sessionState]);

  // Validation attempt navigation state
  const [validationAttempts, setValidationAttempts] = useState<ValidationResult[]>([]);
  const [attemptIndex, setAttemptIndex] = useState(-1); // -1 = show latest (lastValidationResult)

  // Fetch validation history when selected session changes
  useEffect(() => {
    if (!currentSessionId || !selectedSession?.lastValidationResult) {
      setValidationAttempts([]);
      setAttemptIndex(-1);
      return;
    }
    void client
      .getValidations(currentSessionId)
      .then((stored) => {
        setValidationAttempts(stored.map((s) => s.result));
        setAttemptIndex(-1); // reset to latest
      })
      .catch(() => {
        setValidationAttempts([]);
        setAttemptIndex(-1);
      });
  }, [currentSessionId, selectedSession?.lastValidationResult, client]);

  const displayedValidation = useMemo((): ValidationResult | null => {
    if (attemptIndex >= 0 && attemptIndex < validationAttempts.length) {
      return validationAttempts[attemptIndex] ?? null;
    }
    return selectedSession?.lastValidationResult ?? null;
  }, [attemptIndex, validationAttempts, selectedSession]);

  const columnWidths = useMemo(() => calculateColumns(columns), [columns]);

  const isOverlayActive = mode.type !== 'normal';

  // Action handlers — using AutopodClient instead of bare fetch
  const handleTell = useCallback(
    async (message: string) => {
      if (!currentSessionId) return;
      try {
        await client.sendMessage(currentSessionId, message);
        showToast('Message sent', 'green');
      } catch {
        showToast('Failed to send message', 'red');
      }
      setMode({ type: 'normal' });
    },
    [currentSessionId, client, showToast],
  );

  const handlePause = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await client.pauseSession(currentSessionId);
      showToast('Session paused', 'yellow');
    } catch {
      showToast('Failed to pause session', 'red');
    }
  }, [currentSessionId, client, showToast]);

  const handleNudge = useCallback(
    async (message: string) => {
      if (!currentSessionId) return;
      try {
        await client.nudgeSession(currentSessionId, message);
        showToast('Nudge sent', 'green');
      } catch {
        showToast('Failed to send nudge', 'red');
      }
      setMode({ type: 'normal' });
    },
    [currentSessionId, client, showToast],
  );

  const handleApprove = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await client.approveSession(currentSessionId);
    } catch {
      showToast('Failed to approve session', 'red');
    }
    setMode({ type: 'normal' });
  }, [currentSessionId, client, showToast]);

  const handleDelete = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await client.deleteSession(currentSessionId);
      showToast('Session deleted', 'green');
      void refresh();
    } catch {
      showToast('Failed to delete session', 'red');
    }
    setMode({ type: 'normal' });
  }, [currentSessionId, client, showToast, refresh]);

  const handleKill = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      await client.killSession(currentSessionId);
      showToast('Session killed', 'yellow');
    } catch {
      showToast('Failed to kill session', 'red');
    }
    setMode({ type: 'normal' });
  }, [currentSessionId, client, showToast]);

  const handleReject = useCallback(
    async (reason: string) => {
      if (!currentSessionId) return;
      try {
        await client.rejectSession(currentSessionId, reason);
      } catch {
        showToast('Failed to reject session', 'red');
      }
      setMode({ type: 'normal' });
    },
    [currentSessionId, client, showToast],
  );

  const handleCreateComplete = useCallback(
    (session: Session) => {
      setMode({ type: 'normal' });
      showToast(`Session created: ${session.id.slice(0, 8)}`, 'green');
      void refresh();
    },
    [showToast, refresh],
  );

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
        if (
          currentSession?.status === 'running' ||
          currentSession?.status === 'awaiting_input' ||
          currentSession?.status === 'paused'
        ) {
          setMode({ type: 'tell_input' });
        }
      },
      p: () => {
        if (currentSession?.status === 'running') {
          void handlePause();
        }
      },
      u: () => {
        if (currentSession?.status === 'running') {
          setMode({ type: 'nudge_input' });
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
        if (currentSession?.status === 'validated' || currentSession?.status === 'failed') {
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
        if ((currentSession?.status === 'failed' || currentSession?.status === 'killed') && currentSessionId) {
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
      D: () => {
        if (
          currentSession &&
          ['killed', 'complete', 'failed', 'killing'].includes(currentSession.status)
        ) {
          setMode({ type: 'confirm_delete' });
        }
      },
      o: () => {
        if (currentSession?.previewUrl) {
          openUrl(currentSession.previewUrl);
        } else if (
          currentSession &&
          currentSession.containerId &&
          ['validated', 'failed'].includes(currentSession.status)
        ) {
          // Container is stopped — launch preview
          void client
            .startPreview(currentSession.id)
            .then((res) => {
              showToast(`Preview started: ${res.previewUrl}`, 'green');
              void refresh();
            })
            .catch(() => {
              showToast('Failed to start preview', 'red');
            });
        } else if (currentSession?.prUrl) {
          openUrl(currentSession.prUrl);
        }
      },
      w: () => {
        if (selectedSession?.lastValidationResult) {
          void client
            .getReportToken(selectedSession.id)
            .then((res) => {
              const base = daemonUrl.replace(/\/$/, '');
              openUrl(`${base}${res.reportUrl}`);
            })
            .catch(() => {
              // Fallback: open without token (will work in dev mode)
              const reportUrl = `${daemonUrl.replace(/\/$/, '')}/sessions/${selectedSession.id}/report`;
              openUrl(reportUrl);
            });
        }
      },
      '<': () => {
        if (validationAttempts.length > 1) {
          setAttemptIndex((prev) => {
            const current = prev === -1 ? validationAttempts.length - 1 : prev;
            return Math.max(0, current - 1);
          });
        }
      },
      '>': () => {
        if (validationAttempts.length > 1) {
          setAttemptIndex((prev) => {
            if (prev === -1) return -1; // already at latest
            const next = prev + 1;
            return next >= validationAttempts.length ? -1 : next;
          });
        }
      },
      A: () => {
        const count = sessions.filter((s) => s.status === 'validated').length;
        if (count > 0) setMode({ type: 'confirm_bulk_approve', count });
      },
      X: () => {
        const count = sessions.filter((s) => s.status === 'failed').length;
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
    [
      selection,
      currentSession,
      currentSessionId,
      selectedSession,
      sessions,
      ws,
      exit,
      client,
      showToast,
      filterText,
      handlePause,
      handleNudge,
      handleDelete,
      daemonUrl,
      refresh,
      validationAttempts,
    ],
  );

  useKeyboard(keyHandlers, !isOverlayActive);

  // Terminal too small check
  if (columns < 80 || rows < 24) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red" bold>
          Terminal too small
        </Text>
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

  const sessionEvents = currentSessionId ? (agentEvents.get(currentSessionId) ?? []) : [];

  // HotkeyBar props
  const hasPreviewUrl = !!currentSession?.previewUrl;
  const hasValidated = sessions.some((s) => s.status === 'validated');
  const hasFailed = sessions.some((s) => s.status === 'failed');
  const hasFilter = filterText.length > 0;
  const hasValidationResult = !!selectedSession?.lastValidationResult;
  const hasContainerId = !!currentSession?.containerId;
  const hasPrUrl = !!currentSession?.prUrl;

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
          <Text dimColor>
            {' '}
            ({filteredSessions.length}/{sessions.length} sessions)
          </Text>
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
        displayedValidation={displayedValidation}
        totalAttempts={validationAttempts.length || undefined}
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

      {mode.type === 'confirm_delete' && (
        <ConfirmDialog
          message={`Delete session ${currentSessionId ?? ''}? This cannot be undone.`}
          onConfirm={() => void handleDelete()}
          onCancel={() => setMode({ type: 'normal' })}
        />
      )}

      {mode.type === 'diff_view' && (
        <DiffView diff={mode.diff} onClose={() => setMode({ type: 'normal' })} />
      )}

      {mode.type === 'log_view' && (
        <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
          <Box justifyContent="space-between">
            <Text bold>Activity Log — {currentSessionId}</Text>
            <Text dimColor>Esc to close</Text>
          </Box>
          <ActivityLogOverlay events={sessionEvents} onClose={() => setMode({ type: 'normal' })} />
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

      {mode.type === 'nudge_input' && (
        <InlineInput
          prompt="Nudge message (agent picks up on next check_messages):"
          onSubmit={(msg) => void handleNudge(msg)}
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
        hasValidationResult={hasValidationResult}
        hasContainerId={hasContainerId}
        hasPrUrl={hasPrUrl}
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

  // Pre-compute streak warnings: flag runs of 5+ identical consecutive tool_use events
  const tail = events.slice(-40);
  const streakIndices = new Set<number>();
  let streakStart = 0;
  for (let j = 1; j <= tail.length; j++) {
    const prev = tail[j - 1];
    const curr = tail[j];
    const sameKey =
      curr &&
      prev &&
      curr.type === 'tool_use' &&
      prev.type === 'tool_use' &&
      getToolUseKey(curr) === getToolUseKey(prev);
    if (!sameKey) {
      const streakLen = j - streakStart;
      if (streakLen >= 5) {
        for (let k = streakStart; k < j; k++) streakIndices.add(k);
      }
      streakStart = j;
    }
  }

  // Filter out tool_result noise — they just echo tool_use_id with no useful info
  const displayEvents = tail.filter(
    (e) => !(e.type === 'tool_use' && e.tool === 'tool_result'),
  );

  return (
    <Box flexDirection="column">
      {displayEvents.map((event, i) => {
        const ts = new Date(event.timestamp).toLocaleTimeString();
        const isStreak = streakIndices.has(i);
        let tag: string;
        let detail: string;
        switch (event.type) {
          case 'status':
            tag = 'status';
            detail = event.message;
            break;
          case 'tool_use':
            tag = 'tool';
            detail = formatToolUse(event.tool, event.input, 90);
            break;
          case 'file_change':
            tag = event.action;
            detail = event.path;
            break;
          case 'complete':
            tag = 'done';
            detail = event.result;
            break;
          case 'error':
            tag = event.fatal ? 'FATAL' : 'error';
            detail = event.message;
            break;
          case 'escalation':
            tag = 'escalation';
            detail = `${event.escalationType}: ${'question' in event.payload ? event.payload.question : ''}`;
            break;
          default:
            tag = event.type;
            detail = '';
        }
        return (
          <Text key={`log-${i}`} dimColor={!isStreak} wrap="truncate">
            {isStreak ? '\u26A0 ' : ''}
            {ts} [{tag}] {detail}
          </Text>
        );
      })}
    </Box>
  );
}
