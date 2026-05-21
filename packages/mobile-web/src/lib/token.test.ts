import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearStoredToken,
  extractPairingToken,
  readStoredToken,
  readTokenFromHash,
  storeToken,
} from './token.js';

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
    storeToken('x');
    clearStoredToken();
    expect(readStoredToken()).toBeNull();
  });

  it('extracts a token from a full pairing URL', () => {
    expect(extractPairingToken('https://macbook.tail.ts.net/mobile/#token=abc123')).toBe(
      'abc123',
    );
  });

  it('extracts a token from the hash-router pairing URL', () => {
    expect(extractPairingToken('https://macbook.tail.ts.net/mobile/#/pair?token=abc123')).toBe(
      'abc123',
    );
  });

  it('accepts a raw pasted token', () => {
    expect(extractPairingToken('  abc123  ')).toBe('abc123');
  });

  it('falls back to a token query parameter for manual recovery', () => {
    expect(extractPairingToken('https://macbook.tail.ts.net/mobile/?token=abc123')).toBe(
      'abc123',
    );
  });

  it('ignores a URL without a pairing token', () => {
    expect(extractPairingToken('https://macbook.tail.ts.net/mobile/#/scan-again')).toBeNull();
  });
});
