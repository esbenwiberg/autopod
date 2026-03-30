import type { Session } from '@autopod/shared';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { AutopodWebClient, type DaemonAppConfig } from './api/client.js';
import { acquireToken, handleRedirect, initMsal, isSignedIn } from './auth/msal.js';
import { SessionDetail } from './components/SessionDetail.js';
import { SessionList } from './components/SessionList.js';
import { Settings } from './components/Settings.js';
import { useSessions } from './hooks/useSessions.js';
import { type StoredConfig, clearConfig, loadConfig, saveConfig } from './store/config.js';

type View = 'loading' | 'settings' | 'list' | 'detail';

function makeClient(config: StoredConfig, appConfig: DaemonAppConfig): AutopodWebClient {
  if (appConfig.devMode) {
    const token = config.devToken ?? 'dev';
    return new AutopodWebClient({ baseUrl: config.baseUrl, getToken: async () => token });
  }
  return new AutopodWebClient({ baseUrl: config.baseUrl, getToken: acquireToken });
}

export function App(): React.ReactElement {
  const [view, setView] = useState<View>('loading');
  const [config, setConfig] = useState<StoredConfig | null>(null);
  const [client, setClient] = useState<AutopodWebClient | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  // On mount: restore stored config, init MSAL if needed, handle redirect
  useEffect(() => {
    (async () => {
      const stored = loadConfig();
      if (!stored) {
        setView('settings');
        return;
      }

      try {
        const cfg = await AutopodWebClient.fetchAppConfig(stored.baseUrl);
        if (!cfg.devMode && cfg.clientId && cfg.tenantId) {
          await initMsal(cfg.clientId, cfg.tenantId);
          await handleRedirect(); // consume any pending MSAL redirect result
        }

        if (cfg.devMode && !stored.devToken) {
          setConfig(stored);
          setView('settings');
          return;
        }

        if (!cfg.devMode && !isSignedIn()) {
          // MSAL redirect will happen inside acquireToken — trigger it now
          setConfig(stored);
          setView('settings');
          return;
        }

        const c = makeClient(stored, cfg);
        setConfig(stored);
        setClient(c);
        setView('list');
      } catch {
        // Daemon unreachable or config changed — go back to settings
        setView('settings');
      }
    })();
  }, []);

  const { sessions, loading, error, refresh } = useSessions(client);

  const handleSaveConfig = useCallback(
    async (newConfig: StoredConfig, newAppConfig: DaemonAppConfig) => {
      saveConfig(newConfig);
      setConfig(newConfig);

      if (!newAppConfig.devMode && newAppConfig.clientId && newAppConfig.tenantId) {
        await initMsal(newAppConfig.clientId, newAppConfig.tenantId);
        if (!isSignedIn()) {
          // acquireToken triggers the MSAL redirect — page navigates away
          await acquireToken().catch(() => {});
          return;
        }
      }

      const c = makeClient(newConfig, newAppConfig);
      setClient(c);
      setView('list');
    },
    [],
  );

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

  const handleSignOut = useCallback(() => {
    clearConfig();
    setClient(null);
    setConfig(null);
    setView('settings');
  }, []);

  if (view === 'loading') {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
        }}
      >
        Loading…
      </div>
    );
  }

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
        onSettingsClick={handleSignOut}
      />
    </div>
  );
}
