import type { Pod } from '@autopod/shared';
import type { JSX } from 'react';
import { useState } from 'react';
import { ApiError, AuthRequiredError } from '../lib/api.js';
import { type ActionDef, availableActions, runAction } from '../lib/pod-actions.js';
import { usePodsStore } from '../store/pods.js';
import { TextPromptModal } from './TextPromptModal.js';

interface Props {
  pod: Pod;
}

export function ActionBar({ pod }: Props): JSX.Element | null {
  const patchPodLocal = usePodsStore((s) => s.patchPodLocal);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ActionDef | null>(null);

  const actions = availableActions(pod.status);
  if (actions.length === 0) return null;

  async function execute(action: ActionDef, message?: string): Promise<void> {
    setBusy(action.kind);
    setError(null);

    const snapshot: Partial<Pod> | null = action.optimistic
      ? (Object.fromEntries(
          Object.keys(action.optimistic).map((k) => [k, pod[k as keyof Pod]]),
        ) as Partial<Pod>)
      : null;

    if (action.optimistic) patchPodLocal(pod.id, action.optimistic);

    try {
      await runAction(pod.id, action.kind, message);
    } catch (err) {
      if (snapshot) patchPodLocal(pod.id, snapshot);
      if (err instanceof AuthRequiredError) return;
      if (err instanceof ApiError) setError(err.message);
      else setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="action-bar">
        {actions.map((action) => (
          <button
            key={action.kind}
            type="button"
            className={`action-btn action-${action.tone}`}
            disabled={busy !== null}
            onClick={() => {
              if (action.promptsForText) setPrompt(action);
              else void execute(action);
            }}
          >
            {busy === action.kind ? '…' : action.label}
          </button>
        ))}
      </div>
      {error ? <div className="error">{error}</div> : null}
      {prompt ? (
        <TextPromptModal
          title={prompt.label}
          placeholder="Type a message…"
          submitLabel="Send"
          required={prompt.requiresMessage}
          onSubmit={(message) => {
            const action = prompt;
            setPrompt(null);
            void execute(action, message);
          }}
          onCancel={() => setPrompt(null)}
        />
      ) : null}
    </>
  );
}
