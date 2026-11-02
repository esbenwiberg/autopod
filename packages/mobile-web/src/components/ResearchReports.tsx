import type { ResearchFindings } from '@autopod/shared';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api.js';

/** Remount on receipt changes so earlier requests cannot populate newer findings. */
export function ResearchReports({
  podId,
  findings,
}: { podId: string; findings: ResearchFindings }): JSX.Element {
  return (
    <ReceiptReports
      key={`${podId}:${findings.generation}:${findings.cycle}:${findings.evidenceHash}`}
      podId={podId}
      findings={findings}
    />
  );
}

function ReceiptReports({
  podId,
  findings,
}: { podId: string; findings: ResearchFindings }): JSX.Element {
  const [files, setFiles] = useState<Array<{ path: string }>>([]);
  const [content, setContent] = useState('');
  const [pdf, setPdf] = useState<string | null>(null);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ files: Array<{ path: string }> }>(
      `/pods/${podId}/files?ext=md,txt,html,json,csv,log,pdf`,
    )
      .then((value) => {
        if (!cancelled) setFiles(value.files);
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
      requestVersion.current++;
    };
  }, [podId]);
  useEffect(
    () => () => {
      if (pdf) URL.revokeObjectURL(pdf);
    },
    [pdf],
  );

  async function openReport(path: string): Promise<void> {
    const version = ++requestVersion.current;
    setContent('');
    setPdf(null);
    setError('');
    try {
      const value = await apiFetch<{ content: string; encoding: 'base64'; evidenceHash: string }>(
        `/pods/${podId}/findings-receipts/${findings.generation}/${findings.cycle}/content?evidenceHash=${findings.evidenceHash}&path=${encodeURIComponent(path)}`,
      );
      if (requestVersion.current !== version) return;
      if (value.evidenceHash !== findings.evidenceHash || value.encoding !== 'base64') {
        throw new Error('Report does not match the displayed findings receipt');
      }
      const bytes = Uint8Array.from(atob(value.content), (character) => character.charCodeAt(0));
      if (path.toLowerCase().endsWith('.pdf')) {
        setPdf(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })));
      } else {
        setContent(new TextDecoder().decode(bytes));
      }
    } catch (error) {
      if (requestVersion.current === version) setError((error as Error).message);
    }
  }
  return (
    <div>
      {files.map((file) => (
        <button
          type="button"
          key={file.path}
          onClick={() => {
            void openReport(file.path);
          }}
        >
          Open report: {file.path}
        </button>
      ))}
      {error ? <p role="alert">{error}</p> : null}
      {pdf ? (
        <a href={pdf} target="_blank" rel="noopener noreferrer">
          Open PDF report
        </a>
      ) : null}
      {content ? <pre>{content}</pre> : null}
    </div>
  );
}
