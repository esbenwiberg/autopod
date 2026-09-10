import { clearStoredToken, readStoredToken } from './token.js';

export class AuthRequiredError extends Error {
  constructor() {
    super('Authentication required — pair again with `ap mobile pair`');
    this.name = 'AuthRequiredError';
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Lightweight wrapper around `fetch` that:
 *  - Injects `Authorization: Bearer <devToken>` from localStorage
 *  - On 401, clears the stored token + navigates to /scan-again (in browser)
 *    and throws `AuthRequiredError` so callers can short-circuit
 *  - Throws `ApiError` for other non-2xx responses
 *  - Returns the parsed JSON body for 2xx
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    clearStoredToken();
    if (typeof window !== 'undefined' && !window.location.hash.startsWith('#/scan-again')) {
      window.location.hash = '#/scan-again';
    }
    throw new AuthRequiredError();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body || `HTTP ${res.status}`;
    try {
      const error: unknown = JSON.parse(body);
      if (
        error !== null &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string' &&
        error.message.trim()
      ) {
        message = error.message;
      } else if (
        error !== null &&
        typeof error === 'object' &&
        'error' in error &&
        typeof error.error === 'string' &&
        error.error.trim()
      ) {
        message = error.error;
      }
    } catch {
      // Proxies can return plain text; retain that response when it is not JSON.
    }
    throw new ApiError(res.status, message);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
