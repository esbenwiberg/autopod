const STORAGE_KEY = 'autopod.token';
const HASH_PREFIX = '#token=';

/**
 * Reads `#token=<hex>` from the URL fragment (set by `ap mobile pair`),
 * persists it to localStorage, and scrubs the fragment so the token doesn't
 * remain in browser history or accidental screenshots.
 *
 * No-op when the fragment is empty or doesn't contain `#token=`.
 */
export function readTokenFromHash(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return;
  const token = decodeURIComponent(hash.slice(HASH_PREFIX.length));
  if (!token) return;
  window.localStorage.setItem(STORAGE_KEY, token);
  // Replace state so the URL no longer carries the token.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function readStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function clearStoredToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}
