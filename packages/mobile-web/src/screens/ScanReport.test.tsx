import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ScanReport } from './ScanReport.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it('retains a human selection through lost response and reload, and requires a separate repair launch', async () => {
  const finding = {
    id: 'finding-one',
    scanner: 'dependencies',
    ruleId: 'fixture',
    file: 'package-lock.json',
    severity: 'high',
    summary: 'Observed fixture finding',
    disposition: 'unresolved',
  };
  const decision = {
    id: 'selection-one',
    action: 'select_repair',
    findingIds: [finding.id],
    reason: 'Repair this finding',
    actor: { type: 'human', userId: 'fixture' },
    createdAt: '2026-09-07T10:00:00Z',
    repairPodId: null as string | null,
  };
  const detail = {
    report: {
      id: 'report-one',
      status: 'incomplete',
      createdAt: '2026-09-07T10:00:00Z',
      policy: { baseRef: 'main', headRef: 'work' },
      collection: {
        repository: 'fixture',
        files: [],
        diagnostics: ['One scanner failed'],
        scanners: [{ scanner: 'dependencies', status: 'failed', findingCount: null }],
      },
      judgment: { status: 'unavailable' },
    },
    unresolved: [finding],
    decisions: [] as (typeof decision)[],
  };
  const request = {
    requestKey: 'retained-intent',
    action: 'select_repair',
    findingIds: [finding.id],
    reason: 'Repair this finding',
  };
  localStorage.setItem('autopod-scan-triage:report-one', JSON.stringify(request));
  const triageBodies: unknown[] = [];
  let repairs = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/triage')) {
      triageBodies.push(JSON.parse(String(init?.body)));
      detail.decisions = [decision];
      if (triageBodies.length === 1) throw new Error('Response lost after server committed');
      return new Response(JSON.stringify(decision));
    }
    if (String(url).endsWith('/repairs')) {
      repairs++;
      decision.repairPodId = 'repair-one';
      return new Response(
        JSON.stringify({ kind: 'repair_dispatch', podId: 'repair-one', selectionId: decision.id }),
      );
    }
    return new Response(JSON.stringify(detail));
  });
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const render = async () =>
    act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/scan-report/report-one']}>
          <Routes>
            <Route path="/scan-report/:id" element={<ScanReport />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
  const click = async (label: string) =>
    act(async () => {
      const button = [...container.querySelectorAll('button')].find(
        (node) => node.textContent === label,
      );
      expect(button).toBeDefined();
      expect(button?.disabled).toBe(false);
      button?.click();
    });
  try {
    await render();
    expect(container.textContent).toContain('Unknown findings');
    expect(container.textContent).toContain('One scanner failed');
    await click('Record repair selection');
    expect(container.textContent).toContain('decision is retained here for retry');
    expect(repairs).toBe(0);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(request.reason);
    await click('Record repair selection');
    expect(triageBodies).toEqual([request, request]);
    expect(localStorage.getItem('autopod-scan-triage:report-one')).toBeNull();
    expect(repairs).toBe(0);
    expect(container.textContent).toContain('Selection recorded');
    await click('Launch selected repair');
    expect(repairs).toBe(1);
    expect(container.textContent).toContain('Delivery remains unverified');
    expect(container.textContent).toContain('Unresolved findings (1)');
    expect(container.querySelector('a[href="/pod/repair-one"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
