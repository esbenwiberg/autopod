export const STORAGE_KEY = 'autopod.token';
const HASH_PREFIX = '#token=';

export function storeToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, token);
}

function tokenFromHash(hash: string): string | null {
  if (hash.startsWith(HASH_PREFIX)) {
    const token = decodeURIComponent(hash.slice(HASH_PREFIX.length));
    return token || null;
  }

  if (hash.startsWith('#/')) {
    const routeUrl = new URL(hash.slice(1), 'https://autopod.local');
    return routeUrl.searchParams.get('token');
  }

  return null;
}

export function extractPairingToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('/');

  try {
    const url = new URL(
      trimmed,
      typeof window === 'undefined' ? 'https://autopod.local' : window.location.href,
    );
    const hashToken = tokenFromHash(url.hash);
    if (hashToken) return hashToken;
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
    if (looksLikeUrl) return null;
  } catch {
    // Fall through to treating the input as a raw token.
  }

  return trimmed;
}

/**
 * Reads a pairing token from the URL fragment (set by `ap mobile pair`),
 * persists it to localStorage, and scrubs the fragment so the token doesn't
 * remain in browser history or accidental screenshots. Supports the legacy
 * `#token=<hex>` shape and the hash-router-safe `#/pair?token=<hex>` shape.
 *
 * No-op when the fragment is empty or doesn't contain `#token=`.
 */
export function readTokenFromHash(): void {
  if (typeof window === 'undefined') return;
  const token = extractPairingToken(window.location.href);
  if (!token) return;
  storeToken(token);
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
