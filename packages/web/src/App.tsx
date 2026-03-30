import type { Session } from '@autopod/shared';
import type React from 'react';
import { useCallback, useState } from 'react';
import { AutopodWebClient } from './api/client.js';
import { SessionDetail } from './components/SessionDetail.js';
import { SessionList } from './components/SessionList.js';
import { Settings } from './components/Settings.js';
import { useSessions } from './hooks/useSessions.js';
import { type StoredConfig, loadConfig, saveConfig } from './store/config.js';

type View = 'list' | 'detail' | 'settings';

export function App(): React.ReactElement {
  const [config, setConfig] = useState<StoredConfig | null>(loadConfig);
  const [view, setView] = useState<View>(config ? 'list' : 'settings');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  const client = config ? new AutopodWebClient(config) : null;
  const { sessions, loading, error, refresh } = useSessions(client);

  const handleSaveConfig = useCallback((newConfig: StoredConfig) => {
    saveConfig(newConfig);
    setConfig(newConfig);
    setView('list');
  }, []);

  const handleSelectSession = useCallback((session: Session) => {
    setSelectedSession(session);
    setView('detail');
  }, []);

  const handleBack = useCallback(() => {
    setSelectedSession(null);
    setView('list');
    refresh();
  }, [refresh]);

  const handleUpdated = useCallback(() => {
    if (!client || !selectedSession) return;
    client
      .getSession(selectedSession.id)
      .then((s) => setSelectedSession(s))
      .catch(() => {});
    refresh();
  }, [client, selectedSession, refresh]);

  if (view === 'settings') {
    return <Settings current={config} onSave={handleSaveConfig} />;
  }

  if (view === 'detail' && selectedSession && client) {
    return (
      <div style={{ height: '100%' }}>
        <SessionDetail
          session={selectedSession}
          client={client}
          onBack={handleBack}
          onUpdated={handleUpdated}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%' }}>
      <SessionList
        sessions={sessions}
        loading={loading}
        error={error}
        onSelect={handleSelectSession}
        onRefresh={refresh}
        onSettingsClick={() => setView('settings')}
      />
    </div>
  );
}
