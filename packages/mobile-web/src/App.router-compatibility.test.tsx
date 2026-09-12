import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { useManagedPodsStore } from './store/managed-pods.js';
import { usePodsStore } from './store/pods.js';

let root: Root;
let container: HTMLDivElement;
const originalState = usePodsStore.getState();
const originalManagedState = useManagedPodsStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/mobile/#/');
  usePodsStore.setState({ pods: [], loading: false, error: null, refresh: vi.fn(async () => {}) });
  useManagedPodsStore.setState({
    pods: [],
    loading: false,
    loaded: false,
    error: null,
    refresh: vi.fn(async () => {}),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  usePodsStore.setState(originalState, true);
  useManagedPodsStore.setState(originalManagedState, true);
  window.history.replaceState(null, '', '/');
});

it('navigates from the fleet tabs to the separate managed pods view', async () => {
  await act(async () => root.render(<App />));
  await clickLink('#/managed-pods');
  expect(window.location.hash).toBe('#/managed-pods');
  expect(container.querySelector('h1')?.textContent).toBe('Managed Pods');
  expect(container.textContent).toContain('Read-only Dispatcher attempts');
});

async function clickLink(href: string): Promise<void> {
  const link = container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
  expect(link).not.toBeNull();
  await act(async () => {
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

it('retains real App navigation and back links with the upgraded hash router', async () => {
  await act(async () => root.render(<App />));
  expect(container.querySelector('h1')?.textContent).toBe('Autopod');
  await clickLink('#/about');
  expect(window.location.hash).toBe('#/about');
  expect(container.querySelector('h1')?.textContent).toBe('About');
  await clickLink('#/');
  expect(window.location.hash).toBe('#/');
  expect(container.querySelector('h1')?.textContent).toBe('Autopod');
});

it('renders a direct hash route on mount', async () => {
  window.history.replaceState(null, '', '/mobile/#/about');
  await act(async () => root.render(<App />));
  expect(container.querySelector('h1')?.textContent).toBe('About');
});

it('replaces an unknown hash route with the home route', async () => {
  window.history.replaceState(null, '', '/mobile/#/missing-route');
  await act(async () => root.render(<App />));
  expect(window.location.hash).toBe('#/');
  expect(container.querySelector('h1')?.textContent).toBe('Autopod');
});
