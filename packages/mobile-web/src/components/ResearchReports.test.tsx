import type { ResearchFindings } from '@autopod/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/api.js';
import { ResearchReports } from './ResearchReports.js';

vi.mock('../lib/api.js', () => ({ apiFetch: vi.fn() }));
const findings = { generation: 1, cycle: 2, evidenceHash: 'a'.repeat(64) } as ResearchFindings;

it('discards delayed report responses across receipt changes and pins report reads', async () => {
  const fetch = vi.mocked(apiFetch);
  let resolve!: (value: unknown) => void;
  fetch.mockResolvedValueOnce({ files: [{ path: 'report.md' }] });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ResearchReports podId="first" findings={findings} />));
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => container.querySelector('button')?.click());
    expect(fetch.mock.lastCall?.[0]).toBe(
      `/pods/first/findings-receipts/1/2/content?evidenceHash=${findings.evidenceHash}&path=report.md`,
    );
    fetch.mockResolvedValueOnce({ files: [] });
    await act(async () =>
      root.render(<ResearchReports podId="second" findings={{ ...findings, cycle: 3 }} />),
    );
    await act(async () =>
      resolve({
        content: btoa('earlier report'),
        encoding: 'base64',
        evidenceHash: findings.evidenceHash,
      }),
    );
    expect(container.textContent).not.toContain('earlier report');
    expect(container.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    fetch.mockReset();
  }
});

it('opens PDF bytes as a blob and revokes its URL on unmount', async () => {
  const fetch = vi.mocked(apiFetch);
  const create = vi.fn(() => 'blob:report');
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  fetch.mockResolvedValueOnce({ files: [{ path: 'report.pdf' }] });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ResearchReports podId="first" findings={findings} />));
    fetch.mockResolvedValueOnce({
      content: btoa('%PDF-1.7'),
      encoding: 'base64',
      evidenceHash: findings.evidenceHash,
    });
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('blob:report');
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(container.querySelector('pre')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    expect(revoke).toHaveBeenCalledWith('blob:report');
    fetch.mockReset();
    vi.unstubAllGlobals();
  }
});
