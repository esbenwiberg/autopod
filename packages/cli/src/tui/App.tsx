import type { AgentEvent, SystemEvent } from '@autopod/shared';
import { Box, Text } from 'ink';
import React, { createContext, useContext, useCallback, useState, useRef, useMemo } from 'react';
import { AutopodClient } from '../api/client.js';
import { Dashboard } from './Dashboard.js';
import { useSessionState } from './hooks/useSessionState.js';
import type { UseSessionStateReturn } from './hooks/useSessionState.js';
import { useWebSocket } from './hooks/useWebSocket.js';

export interface DashboardConfig {
  daemonUrl: string;
  token: string;
}

// Context for child components to access session state
const SessionStateContext = createContext<UseSessionStateReturn | null>(null);

export function useSessionContext(): UseSessionStateReturn {
  const ctx = useContext(SessionStateContext);
  if (!ctx) throw new Error('useSessionContext must be used within App');
  return ctx;
}

// Context for AutopodClient
const ClientContext = createContext<AutopodClient | null>(null);

export function useClient(): AutopodClient {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useClient must be used within App');
  return ctx;
}

interface AppProps {
  config: DashboardConfig;
}

export function App({ config }: AppProps): React.ReactElement {
  const client = useMemo(
    () =>
      new AutopodClient({
        baseUrl: config.daemonUrl,
        getToken: () => Promise.resolve(config.token),
      }),
    [config.daemonUrl, config.token],
  );

  const [agentEvents, setAgentEvents] = useState<Map<string, AgentEvent[]>>(new Map());
  const sessionState = useSessionState({
    daemonUrl: config.daemonUrl,
    token: config.token,
  });

  const sessionStateRef = useRef(sessionState);
  sessionStateRef.current = sessionState;

  const handleEvent = useCallback((event: SystemEvent) => {
    sessionStateRef.current.handleEvent(event);

    // Track agent activity events per session
    if (event.type === 'session.agent_activity') {
      setAgentEvents((prev) => {
        const next = new Map(prev);
        const existing = next.get(event.sessionId) ?? [];
        next.set(event.sessionId, [...existing, event.event]);
        return next;
      });
    }
  }, []);

  const handleConnect = useCallback(() => {
    void sessionStateRef.current.refresh();
  }, []);

  const handleDisconnect = useCallback(() => {
    // State is preserved; we just show the connection status change
  }, []);

  const wsUrl = `${config.daemonUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/events`;

  const ws = useWebSocket({
    url: wsUrl,
    token: config.token,
    onEvent: handleEvent,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect,
  });

  return (
    <ClientContext.Provider value={client}>
      <SessionStateContext.Provider value={sessionState}>
        <ErrorBoundary>
          <Dashboard sessionState={sessionState} ws={ws} agentEvents={agentEvents} />
        </ErrorBoundary>
      </SessionStateContext.Provider>
    </ClientContext.Provider>
  );
}

// Simple error boundary
interface ErrorBoundaryState {
  error: string | null;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error: error.message };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="red" bold>
            Dashboard Error
          </Text>
          <Text color="red">{this.state.error}</Text>
          <Text dimColor>Press Ctrl+C to exit</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
