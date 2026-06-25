import type { Pod } from '@autopod/shared';
import type { JSX } from 'react';
import { useState } from 'react';
import { ApiError, AuthRequiredError } from '../lib/api.js';
import { toggleSkipValidation } from '../lib/pod-actions.js';
import { usePodsStore } from '../store/pods.js';

interface Props {
  pod: Pod;
}

const SHOW_FOR = new Set<Pod['status']>(['running', 'paused', 'review_required', 'validating']);

export function SkipValidationToggle({ pod }: Props): JSX.Element | null {
  const patchPodLocal = usePodsStore((s) => s.patchPodLocal);
  const [busy, setBusy] = useState(false);

  if (!SHOW_FOR.has(pod.status)) return null;

  async function flip(): Promise<void> {
    const next = !pod.skipValidation;
    setBusy(true);
    patchPodLocal(pod.id, { skipValidation: next });
    try {
      await toggleSkipValidation(pod.id, next);
    } catch (err) {
      patchPodLocal(pod.id, { skipValidation: !next });
      if (err instanceof AuthRequiredError) return;
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={pod.skipValidation}
        disabled={busy}
        onChange={() => void flip()}
      />
      <span>Skip validation on next pass</span>
    </label>
  );
}
