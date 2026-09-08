import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
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
      judgment: {
        status: 'unavailable',
        text: 'Judgment output incomplete; known usage retained.',
        usage: { model: 'fixture-model', inputTokens: 25, outputTokens: 7, costUsd: null },
      },
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
    expect(container.textContent).toContain('32 recorded tokens');
    expect(container.textContent).toContain('Cost: unavailable');
    expect(container.textContent).toContain('Unresolved findings (1 loaded)');
    expect(container.querySelector('a[href="/pod/repair-one"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('loads independent finding and decision pages while preserving a selected finding from a later page', async () => {
  const finding = (id: string) => ({
    id,
    scanner: 'secrets',
    ruleId: 'fixture',
    file: `${id}.ts`,
    severity: 'high',
    summary: `Finding ${id}`,
    disposition: 'unresolved',
  });
  const decision = {
    id: 'older-decision',
    action: 'defer',
    findingIds: ['later'],
    reason: 'Earlier human decision',
    actor: { type: 'human', userId: 'operator' },
    createdAt: 'yesterday',
    repairPodId: null,
  };
  const detail = {
    report: {
      id: 'paged',
      status: 'incomplete',
      createdAt: 'today',
      policy: { baseRef: 'main', headRef: 'work' },
      collection: { files: [], scanners: [], diagnostics: [] },
      judgment: { status: 'unavailable' },
    },
    unresolved: [finding('first')],
    decisions: [],
    unresolvedNextCursor: 'first',
    decisionsNextCursor: 'cursor',
  };
  localStorage.setItem(
    'autopod-scan-triage:paged',
    JSON.stringify({
      requestKey: 'durable-later-selection',
      findingIds: ['later'],
      action: 'select_repair',
      reason: 'Reviewed later item',
    }),
  );
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const path = String(url);
    requests.push(path);
    if (path.includes('/findings?'))
      return new Response(
        JSON.stringify({
          items: [finding('later')],
          nextCursor: null,
          diagnostics: [
            {
              kind: 'finding',
              recordId: 'unreadable-finding',
              message: 'Finding evidence unavailable',
            },
          ],
        }),
      );
    if (path.includes('/decisions?'))
      return new Response(
        JSON.stringify({
          items: [decision],
          nextCursor: null,
          diagnostics: [
            {
              kind: 'decision',
              recordId: 'unreadable-decision',
              message: 'Decision evidence unavailable',
            },
          ],
        }),
      );
    return new Response(JSON.stringify(detail));
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/scan-report/paged']}>
          <Routes>
            <Route path="/scan-report/:id" element={<ScanReport />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    const click = async (label: string) =>
      act(async () =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === label)
          ?.click(),
      );
    await click('Load more findings');
    await click('Load older decisions');
    expect(container.textContent).toContain('Unresolved findings (2 loaded)');
    expect(container.textContent).toContain('unreadable-finding');
    expect(container.textContent).toContain('unreadable-decision');
    expect(container.textContent).toContain('Loaded counts exclude these records');
    const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
    expect(container.textContent).toContain('Earlier human decision');
    expect(container.textContent).not.toContain('Load more findings');
    expect(container.textContent).not.toContain('Load older decisions');
    expect(requests.some((path) => path.endsWith('/findings?after=first'))).toBe(true);
    expect(requests.some((path) => path.endsWith('/decisions?before=cursor'))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('never appends an old report page after navigation to another report', async () => {
  let release: ((response: Response) => void) | undefined;
  const finding = {
    id: 'old',
    scanner: 'secrets',
    ruleId: 'fixture',
    file: 'old.ts',
    severity: 'high',
    summary: 'Old report finding',
    disposition: 'unresolved',
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/findings?'))
      return new Promise((resolve) => {
        release = resolve;
      });
    const id = path.includes('/second/') ? 'second' : 'first';
    return new Response(
      JSON.stringify({
        report: {
          id,
          status: 'incomplete',
          createdAt: 'today',
          policy: { baseRef: 'main', headRef: 'work' },
          collection: { files: [], scanners: [], diagnostics: [] },
          judgment: { status: 'unavailable' },
        },
        unresolved: [],
        decisions: [],
        unresolvedNextCursor: id === 'first' ? 'cursor' : null,
      }),
    );
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/scan-report/first']}>
          <Link to="/scan-report/second">Other report</Link>
          <Routes>
            <Route path="/scan-report/:id" element={<ScanReport />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Load more findings')
        ?.click(),
    );
    await act(async () =>
      container.querySelector<HTMLAnchorElement>('a[href="/scan-report/second"]')?.click(),
    );
    await act(async () =>
      release?.(new Response(JSON.stringify({ items: [finding], nextCursor: null }))),
    );
    expect(container.textContent).not.toContain('Old report finding');
    expect(container.textContent).toContain('Unresolved findings (0 loaded)');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('keeps an unreadable retained selection visible but requires removing it before another decision', async () => {
  localStorage.setItem(
    'autopod-scan-triage:bad',
    JSON.stringify({
      requestKey: 'old-key',
      action: 'select_repair',
      findingIds: ['bad-finding'],
      reason: 'Original reason',
    }),
  );
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        report: {
          id: 'bad',
          status: 'complete',
          createdAt: 'today',
          policy: { baseRef: 'main', headRef: 'work' },
          collection: null,
          judgment: { status: 'not_requested' },
        },
        unresolved: [],
        decisions: [],
        diagnostics: [
          { kind: 'finding', recordId: 'bad-finding', message: 'Finding evidence unavailable' },
        ],
      }),
    ),
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/scan-report/bad']}>
          <Routes>
            <Route path="/scan-report/:id" element={<ScanReport />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((item) => item.textContent === label);
    expect(container.textContent).toContain('bad-finding');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(button('Record repair selection')?.disabled).toBe(true);
    await act(async () => button('Remove unavailable selections')?.click());
    expect(container.textContent).toContain('Recorded decisions remain in history');
    expect(localStorage.getItem('autopod-scan-triage:bad')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(['malformed', 'missing-scope'])(
  'renders unavailable report evidence and refuses actions (%s)',
  async (mode) => {
    localStorage.setItem(
      'autopod-scan-triage:bad-report',
      JSON.stringify({
        requestKey: 'retained',
        action: 'select_repair',
        findingIds: ['finding'],
        reason: 'Retained decision draft',
      }),
    );
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          report: {
            id: 'bad-report',
            status: mode === 'malformed' ? 'complete' : 'incomplete',
            policy: mode === 'malformed' ? null : { baseRef: 'main', headRef: 'work' },
            collection: null,
            judgment: null,
            createdAt: 'today',
            evidenceDiagnostics:
              mode === 'malformed'
                ? [
                    'Policy evidence unavailable',
                    'Collection evidence unavailable',
                    'Judgment evidence unavailable',
                  ]
                : [],
          },
          unresolved: [
            {
              id: 'finding',
              severity: 'high',
              file: 'source.ts',
              summary: 'Earlier readable finding',
              disposition: 'unresolved',
            },
          ],
          decisions: [
            {
              id: 'selection',
              action: 'select_repair',
              findingIds: ['finding'],
              reason: 'Prior human selection',
              createdAt: 'yesterday',
              repairPodId: null,
            },
          ],
        }),
      ),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={['/scan-report/bad-report']}>
            <Routes>
              <Route path="/scan-report/:id" element={<ScanReport />} />
            </Routes>
          </MemoryRouter>,
        ),
      );
      if (mode === 'malformed') {
        expect(container.textContent).toContain('Report evidence unavailable');
        expect(container.textContent).toContain('Recorded status: complete');
        expect(container.textContent).toContain('A clean result cannot be verified');
        expect(container.textContent).toContain('Policy unavailable');
      } else expect(container.textContent).toContain('incomplete');
      expect(container.textContent).toContain('Judgment: unavailable');
      for (const label of ['Record repair selection', 'Launch selected repair']) {
        const button = [...container.querySelectorAll('button')].find(
          (item) => item.textContent === label,
        );
        expect(button?.disabled).toBe(true);
      }
      expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(
        true,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
