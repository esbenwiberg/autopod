import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearStoredToken, readStoredToken, readTokenFromHash } from './token.js';

describe('token storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/mobile/');
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('extracts token from the URL fragment and persists it', () => {
    window.history.replaceState(null, '', '/mobile/#token=deadbeefcafe');
    readTokenFromHash();
    expect(readStoredToken()).toBe('deadbeefcafe');
  });

  it('scrubs the fragment from the URL so the token does not stick around in history', () => {
    window.history.replaceState(null, '', '/mobile/#token=secret');
    readTokenFromHash();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/mobile/');
  });

  it('is a no-op when the fragment does not contain a token', () => {
    window.history.replaceState(null, '', '/mobile/#some-other-hash');
    readTokenFromHash();
    expect(readStoredToken()).toBeNull();
    expect(window.location.hash).toBe('#some-other-hash');
  });

  it('decodes a URL-encoded token', () => {
    window.history.replaceState(null, '', '/mobile/#token=abc%2Bdef');
    readTokenFromHash();
    expect(readStoredToken()).toBe('abc+def');
  });

  it('clearStoredToken removes the persisted value', () => {
    window.localStorage.setItem('autopod.token', 'x');
    clearStoredToken();
    expect(readStoredToken()).toBeNull();
  });
});
