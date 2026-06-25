import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

interface Props {
  title: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** When true, an empty message is rejected. */
  required?: boolean;
  onSubmit: (message: string) => void;
  onCancel: () => void;
}

export function TextPromptModal({
  title,
  placeholder,
  submitLabel = 'Send',
  cancelLabel = 'Cancel',
  required = false,
  onSubmit,
  onCancel,
}: Props): JSX.Element {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Autofocus the textarea on mount + close on Escape.
  useEffect(() => {
    textareaRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSubmit = required ? value.trim().length > 0 : true;

  return (
    <div className="modal-backdrop">
      {/* biome-ignore lint/a11y/useSemanticElements: native <dialog> needs imperative showModal(); keeping a div+role to render declaratively. */}
      <div className="modal" role="dialog" aria-label={title} aria-modal="true">
        <h2 className="modal-title">{title}</h2>
        <textarea
          ref={textareaRef}
          className="modal-textarea"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
        />
        <div className="modal-actions">
          <button type="button" className="action-btn action-neutral" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="action-btn action-primary"
            disabled={!canSubmit}
            onClick={() => onSubmit(value)}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
