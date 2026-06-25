import type { Pod, Profile } from '@autopod/shared';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, AuthRequiredError, apiFetch } from '../lib/api.js';
import { usePodsStore } from '../store/pods.js';

export function Create(): JSX.Element {
  const navigate = useNavigate();
  const upsertPod = usePodsStore((s) => s.upsertPod);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileName, setProfileName] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Profile[]>('/profiles')
      .then((list) => {
        if (cancelled) return;
        setProfiles(list);
        // Pre-select the first profile so the form is ready to submit.
        const first = list[0];
        if (first) setProfileName(first.name);
      })
      .catch((err) => {
        if (cancelled || err instanceof AuthRequiredError) return;
        setError(err instanceof ApiError ? err.message : (err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = profileName.length > 0 && task.trim().length > 0 && !busy;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const pod = await apiFetch<Pod>('/pods', {
        method: 'POST',
        body: JSON.stringify({ profileName, task: task.trim() }),
      });
      upsertPod(pod);
      navigate(`/pod/${pod.id}`);
    } catch (err) {
      if (err instanceof AuthRequiredError) return;
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header className="app-header">
        <h1>New pod</h1>
      </header>

      <label className="form-row">
        <span className="form-label">Profile</span>
        <select
          className="form-select"
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          disabled={profiles.length === 0}
        >
          {profiles.length === 0 ? <option>Loading…</option> : null}
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        <span className="form-label">Task</span>
        <textarea
          className="modal-textarea"
          value={task}
          placeholder="Describe what the agent should do…"
          rows={6}
          onChange={(e) => setTask(e.target.value)}
        />
      </label>

      {error ? <div className="error">{error}</div> : null}

      <div className="form-actions">
        <button type="button" className="action-btn action-neutral" onClick={() => navigate('/')}>
          Cancel
        </button>
        <button
          type="button"
          className="action-btn action-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </main>
  );
}
