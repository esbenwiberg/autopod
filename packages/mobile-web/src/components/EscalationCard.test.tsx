import type { EscalationRequest } from '@autopod/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from '../lib/token.js';
import { EscalationCard } from './EscalationCard.js';

function escalation(overrides: Partial<EscalationRequest>): EscalationRequest {
  return {
    id: 'esc-1',
    podId: 'pod-1',
    type: 'ask_human',
    timestamp: '2026-01-01T00:00:00Z',
    payload: { question: 'Proceed?' },
    response: null,
    ...overrides,
  } as EscalationRequest;
}

function clickByText(container: HTMLElement, text: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  );
  if (!button) throw new Error(`button not found: ${text}`);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function typeInto(container: HTMLElement, text: string): void {
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('textarea not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, text);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type FetchSpy = MockInstance<typeof fetch>;

function expectMessage(spy: FetchSpy, message: string): void {
  expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/message');
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  expect(init.method).toBe('POST');
  expect(init.body).toBe(JSON.stringify({ message }));
}

describe('EscalationCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.setItem(STORAGE_KEY, 'tok');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  async function renderCard(item: EscalationRequest): Promise<void> {
    await act(async () => {
      root.render(<EscalationCard podId="pod-1" escalation={item} />);
    });
  }

  function mockOk() {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  }

  it('posts an ask_human option reply', async () => {
    const spy = mockOk();
    await renderCard(
      escalation({
        type: 'ask_human',
        payload: { question: 'Which path?', context: 'Pick one', options: ['A', 'B'] },
      }),
    );

    expect(container.textContent).toContain('Which path?');
    expect(container.textContent).toContain('Pick one');

    await act(async () => {
      clickByText(container, 'B');
      await flush();
    });

    expectMessage(spy, 'B');
  });

  it('renders validation_override guidance and posts dismiss', async () => {
    const spy = mockOk();
    await renderCard(
      escalation({
        type: 'validation_override',
        payload: {
          attempt: 3,
          maxAttempts: 3,
          findings: [
            {
              id: 'fact:a',
              source: 'fact_validation',
              description: 'profile setup smoke failed',
            },
          ],
        },
      }),
    );

    expect(container.textContent).toContain(
      'Validation found 1 recurring finding(s) after 3/3 attempts.',
    );
    expect(container.textContent).toContain('profile setup smoke failed');
    expect(container.textContent).toContain('dismiss 1,3');

    await act(async () => {
      clickByText(container, 'Dismiss all');
      await flush();
    });

    expectMessage(spy, 'dismiss');
  });

  it('posts typed validation_override guidance', async () => {
    const spy = mockOk();
    await renderCard(
      escalation({
        type: 'validation_override',
        payload: { attempt: 2, maxAttempts: 3, findings: [] },
      }),
    );

    await act(async () => {
      typeInto(container, 'Please fix the smoke script path');
    });
    await act(async () => {
      clickByText(container, 'Send');
      await flush();
    });

    expectMessage(spy, 'Please fix the smoke script path');
  });

  it('posts action approval decisions', async () => {
    const spy = mockOk();
    await renderCard(
      escalation({
        type: 'action_approval',
        payload: {
          actionName: 'deploy',
          description: 'Deploy staging',
          params: { environment: 'staging', force: false },
        },
      }),
    );

    expect(container.textContent).toContain('Approve action: deploy');
    expect(container.textContent).toContain('environment: staging');
    expect(container.textContent).toContain('force: false');

    await act(async () => {
      clickByText(container, 'Approve');
      await flush();
    });

    expectMessage(spy, 'approved');
  });

  it('lets request_credential prompts post a retry reply from mobile', async () => {
    const spy = mockOk();
    await renderCard(
      escalation({
        type: 'request_credential',
        payload: {
          service: 'github',
          reason: 'Update the GitHub PAT, then reply to retry.',
          source: 'host_push',
        },
      }),
    );

    expect(container.textContent).toContain('Update the GitHub PAT');
    expect(container.textContent).not.toContain('Respond from the desktop app.');

    await act(async () => {
      typeInto(container, 'pat updated');
    });
    await act(async () => {
      clickByText(container, 'Send');
      await flush();
    });

    expectMessage(spy, 'pat updated');
  });

  it('lets report_blocker prompts post guidance from mobile', async () => {
    const spy = mockOk();
    await renderCard(
      escalation({
        type: 'report_blocker',
        payload: {
          description: 'Blocked on missing deployment context',
          attempted: ['Checked README', 'Searched env vars'],
          needs: 'Tell me which deployment target to use.',
        },
      }),
    );

    expect(container.textContent).toContain('Blocked on missing deployment context');
    expect(container.textContent).toContain('Checked README');
    expect(container.textContent).toContain('Tell me which deployment target to use.');

    await act(async () => {
      typeInto(container, 'Use staging');
    });
    await act(async () => {
      clickByText(container, 'Send');
      await flush();
    });

    expectMessage(spy, 'Use staging');
  });

  it('keeps typed text visible when sending fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    await renderCard(
      escalation({
        type: 'ask_human',
        payload: { question: 'Need input' },
      }),
    );

    await act(async () => {
      typeInto(container, 'do this');
    });
    await act(async () => {
      clickByText(container, 'Send');
      await flush();
    });

    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('do this');
    expect(container.textContent).toContain('nope');
  });
});
