import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ScanReports } from './ScanReports.js';

afterEach(() => vi.restoreAllMocks());
it('loads older reports without triggering a collection or losing already loaded history', async () => {
  const requests: string[] = [];
  const item = (id: string) => ({
    id,
    jobId: 'job',
    status: 'incomplete',
    createdAt: 'today',
    findingCount: null,
    judgmentStatus: null,
    diagnostics: ['Finding count unavailable; inspect report evidence.'],
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const path = String(url);
    requests.push(path);
    if (path.endsWith('/scheduled-jobs'))
      return new Response(
        JSON.stringify([
          {
            id: 'job',
            name: 'History',
            scan: { baseRef: 'main', headRef: 'work', scanners: [], judgment: 'none' },
          },
        ]),
      );
    return new Response(
      JSON.stringify(
        path.includes('before=')
          ? { items: [item('old')], nextCursor: null }
          : { items: [item('new')], nextCursor: 'new' },
      ),
    );
  });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ScanReports />
        </MemoryRouter>,
      );
    });
    expect(element.querySelector('a[href="/scan-report/new"]')).not.toBeNull();
    const older = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load older reports',
    );
    expect(older).toBeTruthy();
    await act(async () => older?.click());
    expect(element.querySelector('a[href="/scan-report/new"]')).not.toBeNull();
    expect(element.querySelector('a[href="/scan-report/old"]')).not.toBeNull();
    expect(element.textContent).toContain('End of available report history.');
    expect(element.textContent).toContain('Unknown observed findings');
    expect(requests.some((path) => path.endsWith('/report-page?before=new'))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('ignores an older page when the operator switches schedules', async () => {
  let release: ((response: Response) => void) | undefined;
  const item = (id: string, jobId: string) => ({
    id,
    jobId,
    status: 'incomplete',
    createdAt: 'today',
    findingCount: null,
    judgmentStatus: null,
    diagnostics: [],
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/scheduled-jobs'))
      return new Response(
        JSON.stringify(
          ['one', 'two'].map((id) => ({
            id,
            name: id,
            scan: { baseRef: 'main', headRef: 'work', scanners: [], judgment: 'none' },
          })),
        ),
      );
    if (path.includes('before='))
      return new Promise((resolve) => {
        release = resolve;
      });
    const jobId = path.includes('/one/') ? 'one' : 'two';
    return new Response(
      JSON.stringify({ items: [item(jobId, jobId)], nextCursor: jobId === 'one' ? 'one' : null }),
    );
  });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ScanReports />
        </MemoryRouter>,
      );
    });
    await act(async () =>
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === 'Load older reports')
        ?.click(),
    );
    await act(async () => {
      const select = element.querySelector('select');
      if (!select) throw new Error('Missing schedule picker');
      select.value = 'two';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      release?.(
        new Response(JSON.stringify({ items: [item('old-one', 'one')], nextCursor: 'older' })),
      ),
    );
    expect(element.querySelector('a[href="/scan-report/two"]')).not.toBeNull();
    expect(element.querySelector('a[href="/scan-report/old-one"]')).toBeNull();
    expect(element.textContent).not.toContain('Load older reports');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
